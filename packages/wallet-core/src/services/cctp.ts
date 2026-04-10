import { Context, Duration, Effect, Layer } from "effect"
import { bytesToHex } from "@noble/hashes/utils"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { FetchAdapter } from "../adapters/fetch/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { Attestation, BurnMessage, PendingCctpTransfer } from "../model/cctp.js"
import type { ChainId } from "../model/chain.js"
import type { UnsignedTx } from "../model/transaction.js"
import {
  CctpAttestationTimeout,
  CctpMintError,
  FeeEstimationError,
  StorageError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../model/errors.js"

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

      // Delegate actual tx-building to the source adapter. We can't just
      // call buildTransferTx because CCTP needs a contract call, not a
      // plain transfer. Mock adapters recognise `kind: "cctp-burn"`.
      const adapter = yield* registry.get(sourceChain)
      const tx: UnsignedTx = {
        chain: sourceChain,
        from,
        payload: {
          kind: "cctp-burn",
          destChain,
          destDomain: dstConfig.cctpDomain,
          amount: amount.toString(),
          recipient,
        },
        estimatedFee: 2_000n,
        metadata: {
          intent: `CCTP burn ${amount} USDC → ${String(destChain)}`,
          createdAt: Date.now(),
        },
      }
      yield* adapter.estimateFee(tx)
      return tx
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
      // Re-serialise bigints and Uint8Arrays.
      const serialisable = {
        ...transfer,
        burn: transfer.burn
          ? {
              ...transfer.burn,
              nonce: transfer.burn.nonce.toString(),
              messageBytes: bytesToHex(transfer.burn.messageBytes),
            }
          : undefined,
        attestation: transfer.attestation
          ? {
              ...transfer.attestation,
              message: {
                ...transfer.attestation.message,
                nonce: transfer.attestation.message.nonce.toString(),
                messageBytes: bytesToHex(
                  transfer.attestation.message.messageBytes,
                ),
              },
            }
          : undefined,
      }
      yield* storage.save(key, textEncoder.encode(JSON.stringify(serialisable)))
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
          const parsed = JSON.parse(textDecoder.decode(bytes)) as Record<string, unknown>
          // Best-effort restore — callers only use .id / .status / .createdAt in practice.
          results.push(parsed as unknown as PendingCctpTransfer)
        } catch {
          continue
        }
      }
      return results
    }),
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
