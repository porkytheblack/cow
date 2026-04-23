import { Effect } from "effect"
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js"
import { ed25519 } from "@noble/curves/ed25519"
import { keccak_256 } from "@noble/hashes/sha3"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils"
import { base58Encode, base58Decode } from "../../services/keyring-crypto.js"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { CallRequest, CallSimulation } from "../../model/call.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainConfig } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../../model/errors.js"
import type { FetchAdapterShape } from "../fetch/index.js"
import type { ChainAdapter } from "./index.js"
import { jsonRpcCall } from "./json-rpc.js"

// NOTE: @solana/web3.js v1 is still used here. The architecture guide
// targets v2 (functional, browser-native, no `Buffer`). A v2 migration
// requires rewriting the whole transaction/message construction path
// against `@solana/kit` primitives and is tracked as a follow-up. In
// the meantime we cast any required `Buffer` handoffs to keep the
// adapter readable without leaking Node.js types into the public API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asBuffer = (bytes: Uint8Array): any => bytes

/**
 * SolanaChainAdapter — routes all RPC through the injected FetchAdapter
 * (no SDK-bundled `Connection`), builds & signs transactions with the
 * @solana/web3.js v1 `Transaction` / `Keypair` primitives, and supports
 * native SOL transfers plus SPL-token (USDC) transfers.
 *
 * CCTP on Solana is scaffolded: extractBurnMessage / buildMintTx work
 * on a known payload shape that the caller fills in from CCTP program
 * account data. Production CCTP integration requires the Circle Solana
 * program IDs which are configured per-deployment.
 */

// --- Well-known program IDs (pinned) -----------------------------------

const SYSTEM_PROGRAM_ID = SystemProgram.programId
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
)

// SPL Token `Transfer` instruction discriminator.
const SPL_TRANSFER_DISCRIMINATOR = 3

/**
 * Circle's canonical CCTP V1 program IDs on Solana mainnet + devnet.
 *
 * Pulled from https://github.com/circlefin/solana-cctp-contracts
 * (`declare_id!` in `programs/{message-transmitter,token-messenger-minter}/src/lib.rs`)
 * and confirmed via Solana Explorer. Consumers should still pin these in
 * their own config — Circle has re-deployed CCTP programs in the past.
 */
export const DEFAULT_SOLANA_CCTP_V1 = {
  tokenMessengerMinterProgramId: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  messageTransmitterProgramId: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const

// CCTP V1 burn message is 248 bytes: 116-byte header + 132-byte BurnMessage body.
//   header: version(4) | sourceDomain(4) | destDomain(4) | nonce(8) | sender(32) | recipient(32) | destCaller(32)
//   body:   version(4) | burnToken(32) | mintRecipient(32) | amount(32) | messageSender(32)
// All integer fields are big-endian.
const CCTP_MESSAGE_HEADER_LEN = 116
const CCTP_BURN_MESSAGE_BODY_LEN = 132
const CCTP_V1_MESSAGE_LEN = CCTP_MESSAGE_HEADER_LEN + CCTP_BURN_MESSAGE_BODY_LEN

// --- Anchor / Borsh helpers --------------------------------------------

const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * Anchor instruction discriminator: first 8 bytes of
 * `sha256("<namespace>:<name>")`. The `global` namespace is used for
 * user-callable instructions; `event` for `emit_cpi!` events.
 */
const anchorDiscriminator = (
  namespace: "global" | "event",
  name: string,
): Uint8Array => sha256(textBytes(`${namespace}:${name}`)).slice(0, 8)

const u32ToLeBytes = (value: number): Uint8Array => {
  const buf = new Uint8Array(4)
  buf[0] = value & 0xff
  buf[1] = (value >>> 8) & 0xff
  buf[2] = (value >>> 16) & 0xff
  buf[3] = (value >>> 24) & 0xff
  return buf
}

const u32BeFromBytes = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!) >>>
  0

const u32LeFromBytes = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)) >>>
  0

const u64BeFromBytes = (bytes: Uint8Array, offset: number): bigint => {
  let v = 0n
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[offset + i]!)
  return v
}

/**
 * Decode a 32-byte CCTP `mintRecipient` from an arbitrary destination
 * chain's recipient representation. EVM 20-byte addresses are
 * left-padded with zeros; Aptos / Solana already supply 32 bytes.
 */
const cctpMintRecipientBytes = (recipient: string): Uint8Array => {
  // Hex form (0x-prefixed or bare).
  if (/^0x[0-9a-fA-F]+$/.test(recipient) || /^[0-9a-fA-F]+$/.test(recipient)) {
    const clean = recipient.startsWith("0x") ? recipient.slice(2) : recipient
    const bytes = hexToBytes(clean.length % 2 === 0 ? clean : `0${clean}`)
    if (bytes.length > 32) {
      throw new Error(
        `CCTP mintRecipient exceeds 32 bytes (got ${bytes.length})`,
      )
    }
    const padded = new Uint8Array(32)
    padded.set(bytes, 32 - bytes.length)
    return padded
  }
  // Base58 Solana pubkey path.
  return new PublicKey(recipient).toBytes()
}

const findPda = (
  seeds: ReadonlyArray<Uint8Array>,
  programId: PublicKey,
): PublicKey => {
  const [pda] = PublicKey.findProgramAddressSync(
    seeds.map((s) => s),
    programId,
  )
  return pda
}

// --- Helpers ------------------------------------------------------------

const lamportsFromAmount = (amount: bigint): number => {
  // u64 LE encoded later; JS number only used for Connection-style instructions.
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("amount exceeds Number.MAX_SAFE_INTEGER; use token path")
  }
  return Number(amount)
}

const u64ToLeBytes = (value: bigint): Uint8Array => {
  const buf = new Uint8Array(8)
  let v = value
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return buf
}

/**
 * Derive the Associated Token Account (ATA) for an owner + mint. This
 * mirrors `getAssociatedTokenAddressSync` from @solana/spl-token without
 * pulling that package in.
 */
const deriveAta = (owner: PublicKey, mint: PublicKey): PublicKey => {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
}

/**
 * Build an SPL Token `Transfer` instruction:
 *   keys: [source, destination, authority (signer)]
 *   data: [discriminator (u8), amount (u64 LE)]
 */
const buildSplTransferIx = (params: {
  source: PublicKey
  destination: PublicKey
  authority: PublicKey
  amount: bigint
}): TransactionInstruction => {
  const data = new Uint8Array(9)
  data[0] = SPL_TRANSFER_DISCRIMINATOR
  data.set(u64ToLeBytes(params.amount), 1)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
    ],
    data: asBuffer(data),
  })
}

// --- Payload shape ------------------------------------------------------

interface SolanaPayload {
  readonly kind:
    | "direct-transfer"
    | "spl-transfer"
    | "contract-call"
    | "cctp-burn"
    | "cctp-mint"
  /** Base58 recent blockhash — set by buildTransferTx */
  readonly blockhash: string
  readonly lastValidBlockHeight: number
  /** Raw JSON-safe representation of the transaction for sign() to rebuild */
  readonly instructions: ReadonlyArray<{
    readonly programId: string
    readonly keys: ReadonlyArray<{
      readonly pubkey: string
      readonly isSigner: boolean
      readonly isWritable: boolean
    }>
    readonly dataBase58: string
  }>
  readonly feePayer: string
  readonly destChain?: string
  readonly amount?: string
  readonly recipient?: string
  /**
   * CCTP `depositForBurn` requires a fresh `message_sent_event_data`
   * account to be created inside the instruction — it must be a signer.
   * The adapter generates that keypair at build time and stashes its
   * 32-byte ed25519 seed here (base58). `attachSignature` co-signs the
   * serialized message with this seed so the tx ships with the correct
   * two-signer authenticator set.
   *
   * This secret is ephemeral: it's only valid for the containing tx and
   * is discarded once the tx is broadcast. It is NOT derived from the
   * user's mnemonic.
   */
  readonly ephemeralSignerSecretBase58?: string
}

const rehydrateTransaction = (payload: SolanaPayload): Transaction => {
  const tx = new Transaction()
  tx.recentBlockhash = payload.blockhash
  tx.lastValidBlockHeight = payload.lastValidBlockHeight
  tx.feePayer = new PublicKey(payload.feePayer)
  for (const ix of payload.instructions) {
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: asBuffer(base58Decode(ix.dataBase58)),
      }),
    )
  }
  return tx
}

const encodeInstruction = (ix: TransactionInstruction) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  })),
  dataBase58: base58Encode(new Uint8Array(ix.data)),
})

// Universal base64 encoder that works in browsers, React Native, Node 16+.
const base64Encode = (bytes: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (globalThis as any).btoa as ((v: string) => string) | undefined
  if (!b) throw new Error("btoa unavailable")
  return b(s)
}

const base64Decode = (b64: string): Uint8Array => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = (globalThis as any).atob as ((v: string) => string) | undefined
  if (!a) throw new Error("atob unavailable")
  const binary = a(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// --- CCTP V1 instruction builders --------------------------------------

export interface SolanaCctpV1Contracts {
  readonly tokenMessengerMinterProgramId: string
  readonly messageTransmitterProgramId: string
  readonly usdcMint: string
  readonly version?: "v1"
}

interface BuildCctpBurnIxContext {
  readonly owner: PublicKey
  readonly tokenMessengerMinterProgramId: PublicKey
  readonly messageTransmitterProgramId: PublicKey
  readonly usdcMint: PublicKey
  readonly messageSentEventData: PublicKey
  readonly amount: bigint
  readonly destinationDomain: number
  readonly mintRecipient: Uint8Array // 32 bytes
}

/**
 * Build the `TokenMessengerMinter.deposit_for_burn` instruction + a
 * leading `ComputeBudget.setComputeUnitLimit(300_000)` so CCTP burns
 * reliably fit inside the default 200k CU envelope used by SimpleTransaction.
 *
 * Account order + PDA seeds match `programs/token-messenger-minter/src/
 * token_messenger/instructions/deposit_for_burn.rs` in
 * circlefin/solana-cctp-contracts.
 */
const buildSolanaCctpBurnInstructions = (
  ctx: BuildCctpBurnIxContext,
): readonly TransactionInstruction[] => {
  const {
    owner,
    tokenMessengerMinterProgramId: tmm,
    messageTransmitterProgramId: mt,
    usdcMint,
    messageSentEventData,
  } = ctx

  const senderAuthority = findPda([textBytes("sender_authority")], tmm)
  const messageTransmitterState = findPda([textBytes("message_transmitter")], mt)
  const tokenMessengerState = findPda([textBytes("token_messenger")], tmm)
  const remoteTokenMessenger = findPda(
    [textBytes("remote_token_messenger"), textBytes(String(ctx.destinationDomain))],
    tmm,
  )
  const tokenMinter = findPda([textBytes("token_minter")], tmm)
  const localToken = findPda([textBytes("local_token"), usdcMint.toBuffer()], tmm)
  const eventAuthority = findPda([textBytes("__event_authority")], tmm)
  const burnTokenAccount = deriveAta(owner, usdcMint)

  // Anchor ix data: discriminator(8) | amount u64 LE(8) | destDomain u32 LE(4) | mintRecipient [u8;32](32)
  const disc = anchorDiscriminator("global", "deposit_for_burn")
  const data = new Uint8Array(8 + 8 + 4 + 32)
  data.set(disc, 0)
  data.set(u64ToLeBytes(ctx.amount), 8)
  data.set(u32ToLeBytes(ctx.destinationDomain), 16)
  data.set(ctx.mintRecipient, 20)

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 300_000,
  })

  const cctpIx = new TransactionInstruction({
    programId: tmm,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true }, // event_rent_payer
      { pubkey: senderAuthority, isSigner: false, isWritable: false },
      { pubkey: burnTokenAccount, isSigner: false, isWritable: true },
      { pubkey: messageTransmitterState, isSigner: false, isWritable: true },
      { pubkey: tokenMessengerState, isSigner: false, isWritable: false },
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
      { pubkey: tokenMinter, isSigner: false, isWritable: false },
      { pubkey: localToken, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: true },
      { pubkey: messageSentEventData, isSigner: true, isWritable: true },
      { pubkey: mt, isSigner: false, isWritable: false },
      { pubkey: tmm, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: tmm, isSigner: false, isWritable: false }, // `program` trailing account
    ],
    data: asBuffer(data),
  })

  return [computeBudgetIx, cctpIx]
}

/**
 * Parse a CCTP V1 message header + BurnMessage body out of the raw
 * `messageBytes` so `buildMintTx` can derive the PDAs it needs.
 */
const parseCctpV1Message = (bytes: Uint8Array) => {
  if (bytes.length < CCTP_V1_MESSAGE_LEN) {
    throw new Error(
      `CCTP message too short: expected >= ${CCTP_V1_MESSAGE_LEN} bytes, got ${bytes.length}`,
    )
  }
  const sourceDomain = u32BeFromBytes(bytes, 4)
  const destinationDomain = u32BeFromBytes(bytes, 8)
  const nonce = u64BeFromBytes(bytes, 12)
  // body begins at offset 116
  // body layout: version(4) | burnToken(32) | mintRecipient(32) | amount(32) | messageSender(32)
  const bodyOffset = CCTP_MESSAGE_HEADER_LEN
  const burnToken = bytes.slice(bodyOffset + 4, bodyOffset + 4 + 32)
  const mintRecipient = bytes.slice(bodyOffset + 36, bodyOffset + 36 + 32)
  return {
    sourceDomain,
    destinationDomain,
    nonce,
    burnToken,
    mintRecipient,
  }
}

/**
 * CCTP V1 buckets nonces into groups of 6400 for the `used_nonces`
 * account seed. Bucket_start = ((nonce - 1) / 6400) * 6400 + 1.
 * Source: `programs/message-transmitter/src/state.rs::UsedNonces`.
 */
const MAX_NONCES_PER_ACCOUNT = 6400n
const cctpNonceBucketStart = (nonce: bigint): bigint =>
  ((nonce - 1n) / MAX_NONCES_PER_ACCOUNT) * MAX_NONCES_PER_ACCOUNT + 1n

interface BuildCctpMintIxContext {
  readonly payer: PublicKey
  readonly tokenMessengerMinterProgramId: PublicKey
  readonly messageTransmitterProgramId: PublicKey
  readonly usdcMint: PublicKey
  readonly recipientTokenAccount: PublicKey
  readonly sourceDomain: number
  readonly firstNonceInBucket: bigint
  readonly sourceToken: Uint8Array // 32-byte remote USDC address
  readonly messageBytes: Uint8Array
  readonly attestation: Uint8Array
}

/**
 * Build the `MessageTransmitter.receive_message` instruction.
 *
 * Account order matches
 * `programs/message-transmitter/src/instructions/receive_message.rs`,
 * followed by the `handle_receive_message` remaining accounts that the
 * MessageTransmitter forwards to TokenMessengerMinter as a CPI.
 */
const buildSolanaCctpMintInstructions = (
  ctx: BuildCctpMintIxContext,
): readonly TransactionInstruction[] => {
  const {
    payer,
    tokenMessengerMinterProgramId: tmm,
    messageTransmitterProgramId: mt,
    usdcMint,
    recipientTokenAccount,
  } = ctx

  // MessageTransmitter PDAs.
  const authorityPda = findPda(
    [textBytes("message_transmitter_authority"), tmm.toBuffer()],
    mt,
  )
  const messageTransmitterState = findPda([textBytes("message_transmitter")], mt)
  const usedNonces = findPda(
    [
      textBytes("used_nonces"),
      textBytes(String(ctx.sourceDomain)),
      textBytes(ctx.firstNonceInBucket.toString()),
    ],
    mt,
  )
  // MT's own `#[event_cpi]` accounts — required so MT can `emit_cpi!` the
  // MessageReceived event before returning. Missing these shifts the
  // remaining_accounts seen by TMM's handle_receive_message and trips
  // Anchor's seeds check (ConstraintSeeds / 0x7d6).
  const mtEventAuthority = findPda([textBytes("__event_authority")], mt)

  // TokenMessengerMinter remaining accounts (CPI target).
  const tokenMessengerState = findPda([textBytes("token_messenger")], tmm)
  const remoteTokenMessenger = findPda(
    [textBytes("remote_token_messenger"), textBytes(String(ctx.sourceDomain))],
    tmm,
  )
  const tokenMinter = findPda([textBytes("token_minter")], tmm)
  const localToken = findPda([textBytes("local_token"), usdcMint.toBuffer()], tmm)
  const tokenPair = findPda(
    [
      textBytes("token_pair"),
      textBytes(String(ctx.sourceDomain)),
      ctx.sourceToken,
    ],
    tmm,
  )
  const custodyTokenAccount = findPda(
    [textBytes("custody"), usdcMint.toBuffer()],
    tmm,
  )
  const eventAuthority = findPda([textBytes("__event_authority")], tmm)

  // Anchor ix data: disc(8) | message: Vec<u8> (u32 LE len + bytes) | attestation: Vec<u8>
  const disc = anchorDiscriminator("global", "receive_message")
  const msgLen = ctx.messageBytes.length
  const attLen = ctx.attestation.length
  const data = new Uint8Array(8 + 4 + msgLen + 4 + attLen)
  data.set(disc, 0)
  data.set(u32ToLeBytes(msgLen), 8)
  data.set(ctx.messageBytes, 12)
  data.set(u32ToLeBytes(attLen), 12 + msgLen)
  data.set(ctx.attestation, 12 + msgLen + 4)

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  })

  const receiveIx = new TransactionInstruction({
    programId: mt,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false }, // caller (same as payer for self-mint)
      { pubkey: authorityPda, isSigner: false, isWritable: false },
      { pubkey: messageTransmitterState, isSigner: false, isWritable: true },
      { pubkey: usedNonces, isSigner: false, isWritable: true },
      { pubkey: tmm, isSigner: false, isWritable: false }, // receiver = TokenMessengerMinter program
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      // MT's own #[event_cpi] pair — event_authority PDA + MT program id.
      { pubkey: mtEventAuthority, isSigner: false, isWritable: false },
      { pubkey: mt, isSigner: false, isWritable: false },
      // remaining_accounts forwarded to handle_receive_message CPI:
      { pubkey: tokenMessengerState, isSigner: false, isWritable: false },
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
      { pubkey: tokenMinter, isSigner: false, isWritable: true },
      { pubkey: localToken, isSigner: false, isWritable: true },
      { pubkey: tokenPair, isSigner: false, isWritable: false },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: tmm, isSigner: false, isWritable: false }, // program trailing
    ],
    data: asBuffer(data),
  })

  return [computeBudgetIx, receiveIx]
}

// --- Factory ------------------------------------------------------------

export interface SolanaAdapterOptions {
  readonly chainConfig: ChainConfig
  readonly fetcher: FetchAdapterShape
  /**
   * CCTP V1 configuration for this Solana chain. When omitted,
   * `buildCctpBurnTx` / `buildMintTx` fall back to
   * `DEFAULT_SOLANA_CCTP_V1` — Circle's mainnet program IDs. Pass
   * `cctpContracts: null` (or configure the chain without CCTP) to
   * disable CCTP entirely and surface `UnsupportedRouteError`.
   */
  readonly cctpContracts?: SolanaCctpV1Contracts
}

export const makeSolanaChainAdapter = (
  opts: SolanaAdapterOptions,
): ChainAdapter => {
  const { chainConfig, fetcher } = opts
  const rpcUrl = chainConfig.rpcUrl
  const cctp: SolanaCctpV1Contracts =
    opts.cctpContracts ?? DEFAULT_SOLANA_CCTP_V1
  const cctpProgramIds = {
    tmm: new PublicKey(cctp.tokenMessengerMinterProgramId),
    mt: new PublicKey(cctp.messageTransmitterProgramId),
    usdc: new PublicKey(cctp.usdcMint),
  }

  const rpc = <T>(method: string, params: unknown = []) =>
    jsonRpcCall<T>(fetcher, rpcUrl, method, params)

  const adapter: ChainAdapter = {
    chainId: chainConfig.chainId,

    deriveAddress: (publicKey) =>
      Effect.try({
        try: () => {
          if (publicKey.length !== 32) {
            throw new Error(
              `Solana ed25519 pubkey must be 32 bytes, got ${publicKey.length}`,
            )
          }
          return new PublicKey(publicKey).toBase58()
        },
        catch: (e) =>
          new UnsupportedChainError({
            chain: `solana: ${(e as Error).message}`,
          }),
      }),

    buildTransferTx: ({ from, to, asset, amount }) =>
      Effect.gen(function* () {
        // 1. Fetch latest blockhash.
        const blockhashRes = yield* rpc<{
          value: { blockhash: string; lastValidBlockHeight: number }
        }>("getLatestBlockhash", [{ commitment: "finalized" }]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )

        const fromPk = new PublicKey(from)
        const toPk = new PublicKey(to)
        let ix: TransactionInstruction
        let kind: SolanaPayload["kind"]

        if (asset.type === "native") {
          ix = SystemProgram.transfer({
            fromPubkey: fromPk,
            toPubkey: toPk,
            lamports: lamportsFromAmount(amount),
          })
          kind = "direct-transfer"
        } else {
          if (!asset.address) {
            return yield* Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause: "SPL transfer requires asset.address (mint)",
              }),
            )
          }
          const mint = new PublicKey(asset.address)
          const srcAta = deriveAta(fromPk, mint)
          const dstAta = deriveAta(toPk, mint)
          ix = buildSplTransferIx({
            source: srcAta,
            destination: dstAta,
            authority: fromPk,
            amount,
          })
          kind = "spl-transfer"
        }

        const payload: SolanaPayload = {
          kind,
          blockhash: blockhashRes.value.blockhash,
          lastValidBlockHeight: blockhashRes.value.lastValidBlockHeight,
          instructions: [encodeInstruction(ix)],
          feePayer: from,
        }

        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from,
          payload,
          estimatedFee: 5_000n, // typical base fee
          metadata: {
            intent: `Transfer ${amount} ${asset.symbol} to ${to}`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    estimateFee: (_tx) => Effect.succeed(5_000n),

    buildSigningMessage: (tx) =>
      Effect.try({
        try: () => {
          const payload = tx.payload as SolanaPayload
          const solTx = rehydrateTransaction(payload)
          // `serializeMessage` returns the message bytes that every
          // signer ed25519-signs. This is the exact blob KeyringService
          // must sign for the resulting signature to be valid.
          return new Uint8Array(solTx.serializeMessage())
        },
        catch: (cause) =>
          new FeeEstimationError({
            chain: String(chainConfig.chainId),
            cause,
          }),
      }),

    attachSignature: (tx, signature, publicKey) =>
      Effect.try({
        try: () => {
          if (signature.length !== 64) {
            throw new Error(
              `Solana ed25519 signature must be 64 bytes, got ${signature.length}`,
            )
          }
          if (publicKey.length !== 32) {
            throw new Error(
              `Solana ed25519 pubkey must be 32 bytes, got ${publicKey.length}`,
            )
          }
          const payload = tx.payload as SolanaPayload
          const solTx = rehydrateTransaction(payload)

          // CCTP burns require a second signer — the `message_sent_event_data`
          // account. We generated its keypair at build time and stashed the
          // seed on the payload; sign the serialized message with it here so
          // the tx carries both signatures.
          if (payload.ephemeralSignerSecretBase58) {
            const seed = base58Decode(payload.ephemeralSignerSecretBase58)
            const eventKp = Keypair.fromSeed(seed)
            const message = new Uint8Array(solTx.serializeMessage())
            const eventSig = ed25519.sign(message, seed)
            solTx.addSignature(eventKp.publicKey, asBuffer(eventSig))
          }

          solTx.addSignature(new PublicKey(publicKey), asBuffer(signature))
          const raw = new Uint8Array(
            solTx.serialize({ verifySignatures: true }),
          )
          const hash = base58Encode(signature)
          const signed: SignedTx = {
            chain: tx.chain,
            raw,
            hash,
            unsigned: tx,
          }
          return signed
        },
        catch: (cause) =>
          new FeeEstimationError({
            chain: String(chainConfig.chainId),
            cause,
          }),
      }),

    sign: (tx, privateKey) =>
      Effect.gen(function* () {
        // Convenience for adapter-level tests — mirrors the full
        // buildSigningMessage → ed25519 sign → attachSignature flow.
        const msg = yield* adapter.buildSigningMessage(tx).pipe(
          Effect.catchAll((e) =>
            Effect.die(
              new Error(`Solana sign: buildSigningMessage failed: ${e.cause}`),
            ),
          ),
        )
        const publicKey = ed25519.getPublicKey(privateKey)
        const signature = ed25519.sign(msg, privateKey)
        return yield* adapter
          .attachSignature(tx, signature, publicKey)
          .pipe(
            Effect.catchAll((e) =>
              Effect.die(
                new Error(`Solana sign: attachSignature failed: ${e.cause}`),
              ),
            ),
          )
      }),

    buildCallTx: (req) =>
      Effect.gen(function* () {
        if (req.kind !== "solana") {
          return yield* Effect.fail(
            new UnsupportedChainError({
              chain: `Solana adapter received non-Solana CallRequest kind=${req.kind}`,
            }),
          )
        }
        if (req.instructions.length === 0) {
          return yield* Effect.fail(
            new FeeEstimationError({
              chain: String(chainConfig.chainId),
              cause: "Solana CallRequest must include at least one instruction",
            }),
          )
        }

        const blockhashRes = yield* rpc<{
          value: { blockhash: string; lastValidBlockHeight: number }
        }>("getLatestBlockhash", [{ commitment: "finalized" }]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )

        const payload: SolanaPayload = {
          kind: "contract-call",
          blockhash: blockhashRes.value.blockhash,
          lastValidBlockHeight: blockhashRes.value.lastValidBlockHeight,
          instructions: req.instructions.map((ix) => ({
            programId: ix.programId,
            keys: ix.keys.map((k) => ({
              pubkey: k.pubkey,
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            dataBase58: base58Encode(ix.data),
          })),
          feePayer: req.from,
        }

        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from: req.from,
          payload,
          estimatedFee: 5_000n,
          metadata: {
            intent:
              req.label ??
              `Call ${req.instructions.length} instruction(s) on ${String(
                chainConfig.chainId,
              )}`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    simulateCall: (req) =>
      Effect.gen(function* () {
        if (req.kind !== "solana") {
          return yield* Effect.fail(
            new UnsupportedChainError({
              chain: `Solana adapter received non-Solana CallRequest kind=${req.kind}`,
            }),
          )
        }

        const blockhashRes = yield* rpc<{
          value: { blockhash: string; lastValidBlockHeight: number }
        }>("getLatestBlockhash", [{ commitment: "finalized" }]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )

        const solTx = new Transaction()
        solTx.recentBlockhash = blockhashRes.value.blockhash
        solTx.lastValidBlockHeight = blockhashRes.value.lastValidBlockHeight
        solTx.feePayer = new PublicKey(req.from)
        for (const ix of req.instructions) {
          solTx.add(
            new TransactionInstruction({
              programId: new PublicKey(ix.programId),
              keys: ix.keys.map((k) => ({
                pubkey: new PublicKey(k.pubkey),
                isSigner: k.isSigner,
                isWritable: k.isWritable,
              })),
              data: asBuffer(ix.data),
            }),
          )
        }
        const rawBytes = new Uint8Array(
          solTx.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
          }),
        )
        const rawB64 = base64Encode(rawBytes)

        const sim = yield* rpc<{
          value: {
            err: unknown
            logs?: readonly string[]
            unitsConsumed?: number
            returnData?: { data?: readonly [string, string] } | null
          }
        }>("simulateTransaction", [
          rawB64,
          { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true },
        ]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )

        const v = sim.value
        const success = v.err === null || v.err === undefined
        const returnDataB64 = v.returnData?.data?.[0]
        return {
          success,
          returnData: returnDataB64 ? base64Decode(returnDataB64) : undefined,
          gasUsed:
            v.unitsConsumed !== undefined ? BigInt(v.unitsConsumed) : undefined,
          revertReason: success
            ? undefined
            : typeof v.err === "string"
              ? v.err
              : JSON.stringify(v.err),
          logs: v.logs,
          raw: v,
        } satisfies CallSimulation
      }),

    buildCctpBurnTx: ({ from, destinationDomain, recipient, amount }) =>
      Effect.gen(function* () {
        const blockhashRes = yield* rpc<{
          value: { blockhash: string; lastValidBlockHeight: number }
        }>("getLatestBlockhash", [{ commitment: "finalized" }]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )

        // Ephemeral keypair for `message_sent_event_data` — must sign the
        // tx because the CCTP program creates the account with it as the
        // rent-paying signer. `attachSignature` co-signs with its seed.
        const eventSeed = randomBytes(32)
        const eventKeypair = Keypair.fromSeed(eventSeed)

        const mintRecipient = yield* Effect.try({
          try: () => cctpMintRecipientBytes(recipient),
          catch: (cause) =>
            new FeeEstimationError({
              chain: String(chainConfig.chainId),
              cause,
            }),
        })

        const ixs = buildSolanaCctpBurnInstructions({
          owner: new PublicKey(from),
          tokenMessengerMinterProgramId: cctpProgramIds.tmm,
          messageTransmitterProgramId: cctpProgramIds.mt,
          usdcMint: cctpProgramIds.usdc,
          messageSentEventData: eventKeypair.publicKey,
          amount,
          destinationDomain,
          mintRecipient,
        })

        const payload: SolanaPayload = {
          kind: "cctp-burn",
          blockhash: blockhashRes.value.blockhash,
          lastValidBlockHeight: blockhashRes.value.lastValidBlockHeight,
          instructions: ixs.map(encodeInstruction),
          feePayer: from,
          destChain: `cctp:${destinationDomain}`,
          amount: amount.toString(),
          recipient,
          ephemeralSignerSecretBase58: base58Encode(eventSeed),
        }

        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from,
          payload,
          estimatedFee: 5_000n,
          metadata: {
            intent: `CCTP V1 burn ${amount} USDC (domain ${destinationDomain})`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    broadcast: (signed) =>
      Effect.gen(function* () {
        const rawB64 = base64Encode(signed.raw)
        const signature = yield* rpc<string>("sendTransaction", [
          rawB64,
          { encoding: "base64", skipPreflight: false, preflightCommitment: "processed" },
        ]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new BroadcastError({
                chain: String(chainConfig.chainId),
                hash: signed.hash,
                cause,
              }),
            ),
          ),
        )
        // Poll signature status — up to ~30 seconds.
        const start = Date.now()
        const timeoutMs = 30_000
        const intervalMs = 1_000
        while (Date.now() - start < timeoutMs) {
          const statuses = yield* rpc<{
            value: Array<
              | { confirmationStatus?: string; err?: unknown; slot?: number }
              | null
            >
          }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]).pipe(
            Effect.catchAll(() =>
              Effect.succeed({ value: [null] as Array<null> } as {
                value: Array<null>
              }),
            ),
          )
          const status = statuses.value[0]
          if (status && (status.confirmationStatus === "confirmed" ||
              status.confirmationStatus === "finalized")) {
            return {
              chain: chainConfig.chainId,
              hash: signature,
              status: status.err ? "failed" : "confirmed",
              blockNumber:
                typeof status.slot === "number" ? BigInt(status.slot) : undefined,
              fee: 5_000n,
              raw: status,
            } satisfies TxReceipt
          }
          yield* Effect.sleep(intervalMs)
        }
        return yield* Effect.fail(
          new BroadcastError({
            chain: String(chainConfig.chainId),
            hash: signature,
            cause: "signature confirmation timed out",
          }),
        )
      }),

    getBalance: (address, asset) =>
      Effect.gen(function* () {
        if (asset.type === "native") {
          const res = yield* rpc<{ value: number }>("getBalance", [address]).pipe(
            Effect.catchAll(() => Effect.succeed({ value: 0 })),
          )
          return BigInt(res.value)
        }
        if (!asset.address) return 0n
        const owner = new PublicKey(address)
        const mint = new PublicKey(asset.address)
        const ata = deriveAta(owner, mint).toBase58()
        const res = yield* rpc<{
          value: { amount: string; decimals: number } | null
        }>("getTokenAccountBalance", [ata]).pipe(
          Effect.catchAll(() => Effect.succeed({ value: null })),
        )
        return res.value ? BigInt(res.value.amount) : 0n
      }),

    getAllBalances: (address) =>
      Effect.gen(function* () {
        const native = yield* rpc<{ value: number }>("getBalance", [address]).pipe(
          Effect.catchAll(() => Effect.succeed({ value: 0 })),
        )
        const out: TokenBalance[] = [
          {
            asset: chainConfig.nativeAsset,
            balance: BigInt(native.value),
            address,
          },
        ]
        return out
      }),

    extractBurnMessage: (receipt) =>
      Effect.gen(function* () {
        // The caller (CctpService) is expected to have executed a burn
        // instruction targetting the Solana CCTP program. The burn message
        // lives in a program account; parsing it requires the CCTP IDL.
        // As a bridge-layer, we accept a pre-parsed payload on the receipt
        // under `receipt.raw.cctpBurn` and pass it through unchanged.
        const raw = receipt.raw as
          | {
              cctpBurn?: {
                sourceDomain: number
                destDomain: number
                nonce: string
                messageBytesBase58: string
                messageHash: string
              }
            }
          | null
        if (raw?.cctpBurn) {
          const b = raw.cctpBurn
          const burn: BurnMessage = {
            sourceDomain: b.sourceDomain,
            destDomain: b.destDomain,
            nonce: BigInt(b.nonce),
            burnTxHash: receipt.hash,
            messageBytes: base58Decode(b.messageBytesBase58),
            messageHash: b.messageHash,
          }
          return burn
        }
        // Fall back to on-chain reconciliation: read the tx + the
        // `message_sent_event_data` account directly.
        const reconciled = yield* extractBurnMessageFromSolanaTx(
          rpc,
          chainConfig,
          cctp.tokenMessengerMinterProgramId,
          receipt.hash,
        )
        if (!reconciled) {
          return yield* Effect.fail(
            new BroadcastError({
              chain: String(chainConfig.chainId),
              hash: receipt.hash,
              cause:
                "Solana receipt has no cctpBurn metadata and on-chain reconciliation yielded no MessageSent account",
            }),
          )
        }
        return reconciled
      }),

    extractBurnMessageFromTx: (hash) =>
      extractBurnMessageFromSolanaTx(
        rpc,
        chainConfig,
        cctp.tokenMessengerMinterProgramId,
        hash,
      ),

    buildMintTx: ({ recipient, messageBytes, attestation }) =>
      Effect.gen(function* () {
        // Parse the CCTP V1 message header + BurnMessage body to derive
        // the `source_domain`, `nonce`, and `source_token` needed for
        // the `receive_message` PDAs.
        const parsed = yield* Effect.try({
          try: () => parseCctpV1Message(messageBytes),
          catch: (cause) =>
            new FeeEstimationError({
              chain: String(chainConfig.chainId),
              cause,
            }),
        })

        const blockhashRes = yield* rpc<{
          value: { blockhash: string; lastValidBlockHeight: number }
        }>("getLatestBlockhash", [{ commitment: "finalized" }]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )

        const attestationBytes = attestation.startsWith("0x")
          ? hexToBytes(attestation.slice(2))
          : hexToBytes(attestation)

        const payer = new PublicKey(recipient)
        const recipientTokenAccount = deriveAta(payer, cctpProgramIds.usdc)

        const ixs = buildSolanaCctpMintInstructions({
          payer,
          tokenMessengerMinterProgramId: cctpProgramIds.tmm,
          messageTransmitterProgramId: cctpProgramIds.mt,
          usdcMint: cctpProgramIds.usdc,
          recipientTokenAccount,
          sourceDomain: parsed.sourceDomain,
          firstNonceInBucket: cctpNonceBucketStart(parsed.nonce),
          sourceToken: parsed.burnToken,
          messageBytes,
          attestation: attestationBytes,
        })

        const payload: SolanaPayload = {
          kind: "cctp-mint",
          blockhash: blockhashRes.value.blockhash,
          lastValidBlockHeight: blockhashRes.value.lastValidBlockHeight,
          instructions: ixs.map(encodeInstruction),
          feePayer: recipient,
          recipient,
        }
        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from: recipient,
          payload,
          estimatedFee: 5_000n,
          metadata: {
            intent: `CCTP V1 mint on Solana (source domain ${parsed.sourceDomain}, nonce ${parsed.nonce})`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),
  }

  return adapter
}

// --- Reconciliation helper ---------------------------------------------

interface SolanaTxResponse {
  readonly meta?: {
    readonly err?: unknown
  } | null
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly string[]
      readonly instructions?: ReadonlyArray<{
        readonly programIdIndex?: number
        readonly accounts?: readonly number[]
      }>
    }
  }
}

interface SolanaAccountInfoResponse {
  readonly value: {
    readonly data: readonly [string, string] | string
  } | null
}

/**
 * Reconcile a Solana CCTP burn against the cluster: given a signature,
 * fetch the transaction, locate the CCTP `deposit_for_burn` ix, pull
 * the `message_sent_event_data` account key from its account list, and
 * read the `MessageSent` Anchor account data.
 *
 * Layout of the `MessageSent` account:
 *
 *   [ 8 bytes  discriminator
 *   | 32 bytes rent_payer
 *   | 4 bytes  message length (u32 LE)  ← Anchor Vec<u8> prefix
 *   | N bytes  message ]
 *
 * Returns `null` when the tx is not yet visible, has reverted, or the
 * `MessageSent` account has been closed (rent reclaimed). The caller
 * treats `null` as "not confirmed yet" and retries.
 */
const extractBurnMessageFromSolanaTx = (
  rpc: <T>(method: string, params?: unknown) => Effect.Effect<T, unknown>,
  _chainConfig: ChainConfig,
  tokenMessengerMinterProgramId: string,
  signature: string,
): Effect.Effect<BurnMessage | null, BroadcastError> =>
  Effect.gen(function* () {
    const txRes = yield* rpc<SolanaTxResponse | null>("getTransaction", [
      signature,
      {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      },
    ]).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (!txRes) return null
    if (txRes.meta?.err != null) return null

    const message = txRes.transaction?.message
    const accountKeys = message?.accountKeys ?? []
    const instructions = message?.instructions ?? []
    if (accountKeys.length === 0 || instructions.length === 0) return null

    // Locate the deposit_for_burn ix: programId matches the
    // TokenMessengerMinter program, account at index 10 is
    // message_sent_event_data (per buildSolanaCctpBurnInstructions).
    let eventAccountKey: string | undefined
    for (const ix of instructions) {
      if (ix.programIdIndex === undefined) continue
      const progId = accountKeys[ix.programIdIndex]
      if (progId !== tokenMessengerMinterProgramId) continue
      const accounts = ix.accounts ?? []
      if (accounts.length < 11) continue
      const idx = accounts[10]!
      const key = accountKeys[idx]
      if (key) {
        eventAccountKey = key
        break
      }
    }
    if (!eventAccountKey) return null

    const info = yield* rpc<SolanaAccountInfoResponse>("getAccountInfo", [
      eventAccountKey,
      { encoding: "base64" },
    ]).pipe(Effect.catchAll(() => Effect.succeed({ value: null } as SolanaAccountInfoResponse)))
    if (!info.value) return null

    const raw = Array.isArray(info.value.data)
      ? info.value.data[0]
      : info.value.data
    if (typeof raw !== "string") return null
    let accountBytes: Uint8Array
    try {
      accountBytes = base64Decode(raw)
    } catch {
      return null
    }
    // 8 (disc) + 32 (rent_payer) = 40; next 4 bytes are the u32 LE msg length
    const MSG_LEN_OFFSET = 40
    if (accountBytes.length < MSG_LEN_OFFSET + 4) return null
    const msgLen = u32LeFromBytes(accountBytes, MSG_LEN_OFFSET)
    const msgStart = MSG_LEN_OFFSET + 4
    if (accountBytes.length < msgStart + msgLen) return null
    const messageBytes = accountBytes.slice(msgStart, msgStart + msgLen)
    if (messageBytes.length < 24) return null

    // CCTP V1 header: version(4) | sourceDomain(4) | destDomain(4) | nonce(8) ...
    // All big-endian.
    const view = new DataView(
      messageBytes.buffer,
      messageBytes.byteOffset,
      messageBytes.byteLength,
    )
    const sourceDomain = view.getUint32(4, false)
    const destDomain = view.getUint32(8, false)
    const nonce = view.getBigUint64(12, false)
    const messageHash = bytesToHex(keccak_256(messageBytes))
    return {
      sourceDomain,
      destDomain,
      nonce,
      burnTxHash: signature,
      messageBytes,
      messageHash,
    } satisfies BurnMessage
  })
