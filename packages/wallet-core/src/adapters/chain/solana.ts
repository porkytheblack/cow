import { Effect } from "effect"
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js"
import { bytesToHex } from "@noble/hashes/utils"
import { sha256 } from "@noble/hashes/sha256"
import { base58Encode, base58Decode } from "../../services/keyring-crypto.js"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainConfig } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  UnsupportedChainError,
} from "../../model/errors.js"
import type { FetchAdapterShape } from "../fetch/index.js"
import type { ChainAdapter } from "./index.js"
import { jsonRpcCall } from "./json-rpc.js"

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
    data: Buffer.from(data),
  })
}

// --- Payload shape ------------------------------------------------------

interface SolanaPayload {
  readonly kind: "direct-transfer" | "spl-transfer" | "cctp-burn" | "cctp-mint"
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
        data: Buffer.from(base58Decode(ix.dataBase58)),
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

// --- Factory ------------------------------------------------------------

export interface SolanaAdapterOptions {
  readonly chainConfig: ChainConfig
  readonly fetcher: FetchAdapterShape
}

export const makeSolanaChainAdapter = (
  opts: SolanaAdapterOptions,
): ChainAdapter => {
  const { chainConfig, fetcher } = opts
  const rpcUrl = chainConfig.rpcUrl

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

    sign: (tx, privateKey) =>
      Effect.sync(() => {
        const payload = tx.payload as SolanaPayload
        // Solana Keypair.fromSeed takes the 32-byte ed25519 seed.
        const keypair = Keypair.fromSeed(privateKey)
        const solTx = rehydrateTransaction(payload)
        solTx.sign(keypair)
        const raw = new Uint8Array(solTx.serialize({ verifySignatures: true }))
        // Signature is the first 64 bytes of the serialized tx, base58-encoded.
        const sig = solTx.signatures[0]?.signature
        const hash = sig ? base58Encode(new Uint8Array(sig)) : bytesToHex(sha256(raw))
        const signed: SignedTx = {
          chain: tx.chain,
          raw,
          hash,
          unsigned: tx,
        }
        return signed
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
        if (!raw || !raw.cctpBurn) {
          return yield* Effect.fail(
            new BroadcastError({
              chain: String(chainConfig.chainId),
              hash: receipt.hash,
              cause:
                "Solana receipt has no cctpBurn metadata; configure the adapter with a Solana CCTP parser",
            }),
          )
        }
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
      }),

    buildMintTx: ({ recipient, messageBytes, attestation }) =>
      Effect.sync(() => {
        // Build a placeholder CCTP mint transaction. Consumer wiring the
        // Solana CCTP program can replace this by passing a custom
        // adapter factory that overrides buildMintTx.
        const payload: SolanaPayload = {
          kind: "cctp-mint",
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 0,
          instructions: [],
          feePayer: recipient,
          amount: undefined,
          recipient,
        }
        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from: recipient,
          payload,
          estimatedFee: 5_000n,
          metadata: {
            intent: `CCTP mint on Solana (${messageBytes.length}B msg, attestation ${attestation.length / 2}B)`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),
  }

  return adapter
}
