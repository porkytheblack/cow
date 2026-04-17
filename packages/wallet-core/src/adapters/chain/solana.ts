import { Effect } from "effect"
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js"
import { ed25519 } from "@noble/curves/ed25519"
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

    buildCctpBurnTx: (_params) =>
      Effect.fail(
        new UnsupportedRouteError({
          from: String(chainConfig.chainId),
          to: "cctp",
          asset: "USDC",
        }),
      ),

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
