import { Context, Duration, Effect, Layer } from "effect"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { FetchAdapter } from "../adapters/fetch/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { Attestation, BurnMessage, PendingCctpTransfer } from "../model/cctp.js"
import type { ChainId } from "../model/chain.js"
import type { TxReceipt, UnsignedTx } from "../model/transaction.js"
import {
  AuthDeniedError,
  AuthTimeoutError,
  BroadcastError,
  CctpAttestationTimeout,
  CctpMintError,
  FeeEstimationError,
  KeyNotFoundError,
  StorageError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../model/errors.js"
import { AuthGateService } from "./auth-gate.js"
import { BroadcastService } from "./broadcast.js"
import { KeyringService } from "./keyring.js"
import { SignerService } from "./signer.js"

export interface ResumeResult {
  readonly transfer: PendingCctpTransfer
  readonly mintReceipt: TxReceipt
}

export interface CctpServiceShape {
  readonly buildBurnTx: (params: {
    readonly sourceChain: ChainId
    readonly destChain: ChainId
    readonly amount: bigint
    readonly from: string
    readonly recipient: string
  }) => Effect.Effect<
    UnsignedTx,
    UnsupportedRouteError | UnsupportedChainError | FeeEstimationError,
    ChainAdapterRegistry | WalletConfigService
  >

  readonly waitForAttestation: (
    burn: BurnMessage,
  ) => Effect.Effect<
    Attestation,
    CctpAttestationTimeout,
    FetchAdapter | WalletConfigService
  >

  readonly buildMintTx: (
    recipient: string,
    destChain: ChainId,
    attestation: Attestation,
  ) => Effect.Effect<
    UnsignedTx,
    CctpMintError | UnsupportedChainError | FeeEstimationError,
    ChainAdapterRegistry
  >

  readonly savePending: (
    transfer: PendingCctpTransfer,
  ) => Effect.Effect<void, StorageError, StorageAdapter>

  readonly loadPending: () => Effect.Effect<
    readonly PendingCctpTransfer[],
    StorageError,
    StorageAdapter
  >

  /**
   * Resume a pending CCTP transfer after restart. Picks up from whichever
   * step was persisted last: awaits attestation if burn is stored, then
   * builds + signs + broadcasts the mint, and updates the persisted status.
   */
  readonly resumePending: (
    id: string,
    recipient: string,
    destChain: ChainId,
  ) => Effect.Effect<
    ResumeResult,
    | StorageError
    | CctpAttestationTimeout
    | CctpMintError
    | UnsupportedChainError
    | FeeEstimationError
    | BroadcastError
    | AuthDeniedError
    | AuthTimeoutError
    | KeyNotFoundError,
    | ChainAdapterRegistry
    | SignerService
    | BroadcastService
    | StorageAdapter
    | FetchAdapter
    | WalletConfigService
    | KeyringService
    | AuthGateService
  >
}

export class CctpService extends Context.Tag("CctpService")<
  CctpService,
  CctpServiceShape
>() {}

const STORAGE_PREFIX = "cctp:pending:"
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface CircleAttestationResponse {
  readonly status?: string
  readonly attestation?: string
  readonly messages?: ReadonlyArray<{
    readonly status?: string
    readonly attestation?: string
  }>
}

export const CctpServiceLive = Layer.succeed(CctpService, {
  buildBurnTx: ({ sourceChain, destChain, amount, from, recipient }) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const configService = yield* WalletConfigService
      const srcConfig = yield* configService.getChain(sourceChain)
      const dstConfig = yield* configService.getChain(destChain)

      if (
        srcConfig.cctpDomain === undefined ||
        dstConfig.cctpDomain === undefined
      ) {
        return yield* Effect.fail(
          new UnsupportedRouteError({
            from: String(sourceChain),
            to: String(destChain),
            asset: "USDC",
          }),
        )
      }

      // Delegate tx building to the source chain adapter, which knows
      // how to encode `TokenMessenger.depositForBurn` for its chain.
      // Mock adapters return a `{ kind: "cctp-burn", ... }` payload.
      const adapter = yield* registry.get(sourceChain)
      return yield* adapter.buildCctpBurnTx({
        from,
        destinationDomain: dstConfig.cctpDomain,
        recipient,
        amount,
      })
    }),

  waitForAttestation: (burn) =>
    Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const configService = yield* WalletConfigService
      const cctp = configService.config.cctp
      return yield* pollCircleAttestation(fetcher, cctp.attestationApiUrl, burn, {
        intervalMs: cctp.attestationPollIntervalMs,
        timeoutMs: cctp.attestationTimeoutMs,
      })
    }),

  buildMintTx: (recipient, destChain, attestation) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(destChain)
      const tx = yield* adapter
        .buildMintTx({
          recipient,
          messageBytes: attestation.message.messageBytes,
          attestation: attestation.attestation,
        })
        .pipe(
          Effect.catchTag("FeeEstimationError", (e) =>
            Effect.fail(
              new CctpMintError({ destChain, cause: e }),
            ),
          ),
        )
      return tx
    }),

  savePending: (transfer) =>
    Effect.gen(function* () {
      const storage = yield* StorageAdapter
      const key = `${STORAGE_PREFIX}${transfer.id}`
      yield* storage.save(
        key,
        textEncoder.encode(JSON.stringify(serialisePending(transfer))),
      )
    }),

  loadPending: () =>
    Effect.gen(function* () {
      const storage = yield* StorageAdapter
      const keys = yield* storage.list(STORAGE_PREFIX)
      const results: PendingCctpTransfer[] = []
      for (const key of keys) {
        const bytes = yield* storage.load(key)
        if (!bytes) continue
        try {
          const parsed = JSON.parse(textDecoder.decode(bytes)) as SerialisedPending
          results.push(deserialisePending(parsed))
        } catch {
          continue
        }
      }
      return results
    }),

  resumePending: (id, recipient, destChain) =>
    Effect.gen(function* () {
      const storage = yield* StorageAdapter
      const signer = yield* SignerService
      const broadcast = yield* BroadcastService
      const fetcher = yield* FetchAdapter
      const configService = yield* WalletConfigService
      const cctp = configService.config.cctp

      const key = `${STORAGE_PREFIX}${id}`
      const bytes = yield* storage.load(key)
      if (!bytes) {
        return yield* Effect.fail(
          new StorageError({
            operation: "read",
            key,
            cause: "no pending CCTP transfer with that id",
          }),
        )
      }
      let current: PendingCctpTransfer
      try {
        current = deserialisePending(
          JSON.parse(textDecoder.decode(bytes)) as SerialisedPending,
        )
      } catch (e) {
        return yield* Effect.fail(
          new StorageError({
            operation: "read",
            key,
            cause: `failed to parse pending CCTP record: ${(e as Error).message}`,
          }),
        )
      }

      if (!current.burn) {
        return yield* Effect.fail(
          new CctpMintError({
            destChain,
            cause: "pending transfer has no burn payload to resume from",
          }),
        )
      }

      // 1. Get (or wait for) the attestation.
      let attestation = current.attestation
      if (!attestation) {
        const awaiting: PendingCctpTransfer = {
          ...current,
          status: "awaiting-attestation",
          updatedAt: Date.now(),
        }
        yield* storage.save(
          key,
          textEncoder.encode(JSON.stringify(serialisePending(awaiting))),
        )
        attestation = yield* pollCircleAttestation(
          fetcher,
          cctp.attestationApiUrl,
          current.burn,
          {
            intervalMs: cctp.attestationPollIntervalMs,
            timeoutMs: cctp.attestationTimeoutMs,
          },
        )
      }

      // Persist the attestation before we try to mint.
      const attested: PendingCctpTransfer = {
        ...current,
        status: "attested",
        attestation,
        updatedAt: Date.now(),
      }
      yield* storage.save(
        key,
        textEncoder.encode(JSON.stringify(serialisePending(attested))),
      )

      // 2. Build and submit the mint on the destination chain.
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(destChain)
      const mintTx = yield* adapter
        .buildMintTx({
          recipient,
          messageBytes: attestation.message.messageBytes,
          attestation: attestation.attestation,
        })
        .pipe(
          Effect.catchTag("FeeEstimationError", (e) =>
            Effect.fail(new CctpMintError({ destChain, cause: e })),
          ),
        )
      const signed = yield* signer.sign(mintTx)
      const mintReceipt = yield* broadcast.submit(signed)

      const completed: PendingCctpTransfer = {
        ...attested,
        status: "completed",
        mintTxHash: mintReceipt.hash,
        updatedAt: Date.now(),
      }
      yield* storage.save(
        key,
        textEncoder.encode(JSON.stringify(serialisePending(completed))),
      )

      return { transfer: completed, mintReceipt }
    }),
})

// --- Persistence codec ---------------------------------------------------

interface SerialisedBurn {
  readonly sourceDomain: number
  readonly destDomain: number
  readonly nonce: string
  readonly burnTxHash: string
  readonly messageBytes: string
  readonly messageHash: string
}

interface SerialisedPending {
  readonly id: string
  readonly planId: string
  readonly status: PendingCctpTransfer["status"]
  readonly createdAt: number
  readonly updatedAt: number
  readonly mintTxHash?: string
  readonly burn?: SerialisedBurn
  readonly attestation?: {
    readonly message: SerialisedBurn
    readonly attestation: string
  }
}

const serialiseBurn = (burn: BurnMessage): SerialisedBurn => ({
  sourceDomain: burn.sourceDomain,
  destDomain: burn.destDomain,
  nonce: burn.nonce.toString(),
  burnTxHash: burn.burnTxHash,
  messageBytes: bytesToHex(burn.messageBytes),
  messageHash: burn.messageHash,
})

const deserialiseBurn = (b: SerialisedBurn): BurnMessage => ({
  sourceDomain: b.sourceDomain,
  destDomain: b.destDomain,
  nonce: BigInt(b.nonce),
  burnTxHash: b.burnTxHash,
  messageBytes: hexToBytes(b.messageBytes),
  messageHash: b.messageHash,
})

const serialisePending = (
  t: PendingCctpTransfer,
): SerialisedPending => ({
  id: t.id,
  planId: t.planId,
  status: t.status,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  ...(t.mintTxHash !== undefined ? { mintTxHash: t.mintTxHash } : {}),
  ...(t.burn ? { burn: serialiseBurn(t.burn) } : {}),
  ...(t.attestation
    ? {
        attestation: {
          message: serialiseBurn(t.attestation.message),
          attestation: t.attestation.attestation,
        },
      }
    : {}),
})

const deserialisePending = (
  s: SerialisedPending,
): PendingCctpTransfer => ({
  id: s.id,
  planId: s.planId,
  status: s.status,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  ...(s.mintTxHash !== undefined ? { mintTxHash: s.mintTxHash } : {}),
  ...(s.burn ? { burn: deserialiseBurn(s.burn) } : {}),
  ...(s.attestation
    ? {
        attestation: {
          message: deserialiseBurn(s.attestation.message),
          attestation: s.attestation.attestation,
        },
      }
    : {}),
})

/**
 * Retry `waitForAttestation` using a simple poll-loop that respects
 * the configured interval + timeout. Re-exported for tests that want
 * to poll manually.
 */
export const pollCircleAttestation = (
  fetcher: Context.Tag.Service<FetchAdapter>,
  apiUrl: string,
  burn: BurnMessage,
  opts: { intervalMs: number; timeoutMs: number },
): Effect.Effect<Attestation, CctpAttestationTimeout> =>
  Effect.gen(function* () {
    const url = `${apiUrl.replace(/\/$/, "")}/attestations/0x${burn.messageHash}`
    const start = Date.now()
    while (Date.now() - start < opts.timeoutMs) {
      const res = yield* fetcher.request({ url, method: "GET" }).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (res) {
        const json = yield* res.json<CircleAttestationResponse>().pipe(
          Effect.catchAll(() => Effect.succeed<CircleAttestationResponse>({})),
        )
        const first = json.messages?.[0]
        const status = first?.status ?? json.status
        const attBytes = first?.attestation ?? json.attestation
        if (status === "complete" && attBytes) {
          return {
            message: burn,
            attestation: attBytes.startsWith("0x") ? attBytes.slice(2) : attBytes,
          }
        }
      }
      yield* Effect.sleep(Duration.millis(opts.intervalMs))
    }
    return yield* Effect.fail(
      new CctpAttestationTimeout({
        burnTxHash: burn.burnTxHash,
        elapsedMs: Date.now() - start,
      }),
    )
  })
