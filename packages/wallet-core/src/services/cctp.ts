import { Context, Duration, Effect, Layer } from "effect"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { FetchAdapter } from "../adapters/fetch/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService, type WalletConfig } from "../config/index.js"
import { CCTP_VERSIONS } from "../config/defaults.js"
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
   * Apply a shallow patch to a persisted pending transfer without
   * round-tripping the whole record. A no-op if the id is absent.
   * `updatedAt` is set automatically when the caller does not supply one.
   */
  readonly updatePending: (
    id: string,
    patch: Partial<PendingCctpTransfer>,
  ) => Effect.Effect<void, StorageError, StorageAdapter>

  /**
   * Resume a pending CCTP transfer after restart. Picks up from whichever
   * step was persisted last: awaits attestation if burn is stored, then
   * builds + signs + broadcasts the mint, and updates the persisted status.
   *
   * `recipient` and `destChain` are read from the stored record when
   * omitted — they were persisted at burn time by `TransferService`.
   */
  readonly resumePending: (
    id: string,
    recipient?: string,
    destChain?: ChainId,
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
      const version = resolveSourceCctpVersion(
        configService.config,
        burn.sourceDomain,
      )
      return yield* pollCircleAttestation(fetcher, cctp.attestationApiUrl, burn, {
        intervalMs: cctp.attestationPollIntervalMs,
        timeoutMs: cctp.attestationTimeoutMs,
        version,
      })
    }),

  buildMintTx: (recipient, destChain, attestation) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(destChain)
      const messageBytes = attestation.message.messageBytes
      if (!messageBytes) {
        return yield* Effect.fail(
          new CctpMintError({
            destChain,
            cause:
              "attestation is missing messageBytes — burn has not been reconciled against the source chain",
          }),
        )
      }
      const tx = yield* adapter
        .buildMintTx({
          recipient,
          messageBytes,
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

  updatePending: (id, patch) =>
    Effect.gen(function* () {
      const storage = yield* StorageAdapter
      const key = `${STORAGE_PREFIX}${id}`
      const bytes = yield* storage.load(key)
      if (!bytes) return
      let current: PendingCctpTransfer
      try {
        current = deserialisePending(
          JSON.parse(textDecoder.decode(bytes)) as SerialisedPending,
        )
      } catch {
        return
      }
      const merged: PendingCctpTransfer = {
        ...current,
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      }
      yield* storage.save(
        key,
        textEncoder.encode(JSON.stringify(serialisePending(merged))),
      )
    }),

  resumePending: (id, recipientOverride, destChainOverride) =>
    Effect.gen(function* () {
      const storage = yield* StorageAdapter
      const signer = yield* SignerService
      const broadcast = yield* BroadcastService
      const fetcher = yield* FetchAdapter
      const configService = yield* WalletConfigService
      const cctpConfig = configService.config.cctp
      const registry = yield* ChainAdapterRegistry

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

      const recipient = recipientOverride ?? current.recipient
      const destChain = destChainOverride ?? current.destChain
      if (!recipient || !destChain) {
        return yield* Effect.fail(
          new CctpMintError({
            destChain: destChain ?? "unknown",
            cause:
              "pending record has no recipient/destChain and none were supplied — cannot resume",
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
      let burn: BurnMessage = current.burn

      // 0. If the record is still in `"burning"` — save-before-broadcast
      //    left us here — reconcile against the source chain first. The
      //    sourceChain may be absent on old records; we skip reconciliation
      //    in that case and fall through (only burns from post-fix
      //    versions store `sourceChain`).
      if (current.status === "burning" && current.sourceChain) {
        const srcAdapter = yield* registry.get(current.sourceChain)
        const reconciled = yield* srcAdapter
          .extractBurnMessageFromTx(burn.burnTxHash)
          .pipe(
            Effect.catchTag("BroadcastError", () =>
              Effect.succeed(null as BurnMessage | null),
            ),
          )
        if (!reconciled) {
          return yield* Effect.fail(
            new CctpMintError({
              destChain,
              cause:
                "burn tx not yet visible on source chain — cannot advance; try again later",
            }),
          )
        }
        burn = reconciled
        current = {
          ...current,
          status: "awaiting-attestation",
          burn: reconciled,
          updatedAt: Date.now(),
        }
        yield* storage.save(
          key,
          textEncoder.encode(JSON.stringify(serialisePending(current))),
        )
      }

      // 1. Get (or wait for) the attestation.
      let attestation = current.attestation
      if (!attestation) {
        if (!burn.messageBytes || !burn.messageHash) {
          return yield* Effect.fail(
            new CctpMintError({
              destChain,
              cause:
                "burn record is missing messageBytes/messageHash — source chain has not been reconciled",
            }),
          )
        }
        const awaiting: PendingCctpTransfer = {
          ...current,
          status: "awaiting-attestation",
          updatedAt: Date.now(),
        }
        yield* storage.save(
          key,
          textEncoder.encode(JSON.stringify(serialisePending(awaiting))),
        )
        const version = resolveSourceCctpVersion(
          configService.config,
          burn.sourceDomain,
        )
        attestation = yield* pollCircleAttestation(
          fetcher,
          cctpConfig.attestationApiUrl,
          burn,
          {
            intervalMs: cctpConfig.attestationPollIntervalMs,
            timeoutMs: cctpConfig.attestationTimeoutMs,
            version,
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

      // 2. Build and submit the mint on the destination chain. Save
      //    `minting` before broadcast so a broadcast error or crash
      //    leaves us in a recoverable state.
      const adapter = yield* registry.get(destChain)
      const mintMessageBytes = attestation.message.messageBytes
      if (!mintMessageBytes) {
        return yield* Effect.fail(
          new CctpMintError({
            destChain,
            cause:
              "attestation is missing messageBytes — cannot build mint",
          }),
        )
      }
      const mintTx = yield* adapter
        .buildMintTx({
          recipient,
          messageBytes: mintMessageBytes,
          attestation: attestation.attestation,
        })
        .pipe(
          Effect.catchTag("FeeEstimationError", (e) =>
            Effect.fail(new CctpMintError({ destChain, cause: e })),
          ),
        )
      const signed = yield* signer.sign(mintTx)
      const minting: PendingCctpTransfer = {
        ...attested,
        status: "minting",
        mintTxHash: signed.hash,
        updatedAt: Date.now(),
      }
      yield* storage.save(
        key,
        textEncoder.encode(JSON.stringify(serialisePending(minting))),
      )

      const mintReceipt = yield* broadcast.submit(signed)

      const completed: PendingCctpTransfer = {
        ...minting,
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
  readonly messageBytes?: string
  readonly messageHash?: string
}

interface SerialisedPending {
  readonly id: string
  readonly planId: string
  readonly status: PendingCctpTransfer["status"]
  readonly createdAt: number
  readonly updatedAt: number
  readonly mintTxHash?: string
  readonly sourceChain?: string
  readonly destChain?: string
  readonly recipient?: string
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
  ...(burn.messageBytes !== undefined
    ? { messageBytes: bytesToHex(burn.messageBytes) }
    : {}),
  ...(burn.messageHash !== undefined ? { messageHash: burn.messageHash } : {}),
})

const deserialiseBurn = (b: SerialisedBurn): BurnMessage => ({
  sourceDomain: b.sourceDomain,
  destDomain: b.destDomain,
  nonce: BigInt(b.nonce),
  burnTxHash: b.burnTxHash,
  ...(b.messageBytes !== undefined
    ? { messageBytes: hexToBytes(b.messageBytes) }
    : {}),
  ...(b.messageHash !== undefined ? { messageHash: b.messageHash } : {}),
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
  ...(t.sourceChain !== undefined ? { sourceChain: t.sourceChain } : {}),
  ...(t.destChain !== undefined ? { destChain: t.destChain } : {}),
  ...(t.recipient !== undefined ? { recipient: t.recipient } : {}),
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
  ...(s.sourceChain !== undefined ? { sourceChain: s.sourceChain } : {}),
  ...(s.destChain !== undefined ? { destChain: s.destChain } : {}),
  ...(s.recipient !== undefined ? { recipient: s.recipient } : {}),
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

// It is the source chain (not the destination) that decides whether
// the burn message flows through Iris V1 or V2.
const resolveSourceCctpVersion = (
  config: WalletConfig,
  sourceDomain: number,
): "v1" | "v2" => {
  const match = config.chains.find((c) => c.cctpDomain === sourceDomain)
  if (match) {
    const override = config.cctp.contractAddresses[match.chainId]?.version
    if (override) return override
    const known = CCTP_VERSIONS[match.chainId]
    if (known) return known
  }
  return "v2"
}

/**
 * Poll Circle's Iris API until an attestation is available. Exported for
 * tests that want to drive the loop directly. If `apiUrl` already ends
 * with `/v1` or `/v2` that segment is preserved; otherwise `opts.version`
 * selects the path.
 */
export const pollCircleAttestation = (
  fetcher: Context.Tag.Service<FetchAdapter>,
  apiUrl: string,
  burn: BurnMessage,
  opts: {
    intervalMs: number
    timeoutMs: number
    version?: "v1" | "v2"
  },
): Effect.Effect<Attestation, CctpAttestationTimeout> =>
  Effect.gen(function* () {
    const trimmed = apiUrl.replace(/\/$/, "")
    const hasVersion = /\/v[12]$/.test(trimmed)
    const base = hasVersion ? trimmed : `${trimmed}/${opts.version ?? "v2"}`
    const url = `${base}/attestations/0x${burn.messageHash}`
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
