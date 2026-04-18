import { Effect, Layer } from "effect"
import type { Aptos } from "@aptos-labs/ts-sdk"
import { WalletConfigService } from "../../config/index.js"
import type { ChainConfig, ChainId } from "../../model/chain.js"
import { UnsupportedChainError } from "../../model/errors.js"
import { FetchAdapter } from "../fetch/index.js"
import type { ChainAdapter } from "./index.js"
import { ChainAdapterRegistry } from "./index.js"
import { makeEvmChainAdapter } from "./evm.js"
import { makeSolanaChainAdapter } from "./solana.js"
import { makeAptosChainAdapter } from "./aptos.js"
import { APTOS_CCTP_V1_MAINNET } from "./aptos-cctp-scripts.js"
import { makeMockChainAdapter } from "./mock.js"

/**
 * Live ChainAdapterRegistry layer.
 *
 * Reads `WalletConfigService` and instantiates one adapter per configured
 * chain. The `kind` field on each ChainConfig selects the implementation:
 *
 *   - "mock"   -> makeMockChainAdapter (in-memory, deterministic — tests)
 *   - "evm"    -> makeEvmChainAdapter  (viem + FetchAdapter transport)
 *   - "solana" -> makeSolanaChainAdapter (@solana/web3.js + FetchAdapter)
 *   - "aptos"  -> falls back to mock and emits a warning to
 *                 `console.warn`, because the Aptos SDK needs a
 *                 caller-constructed `Aptos` client — use
 *                 `makeAptosAwareRegistryLive(aptosClients)` below, or
 *                 build a custom registry via
 *                 `makeChainAdapterRegistryLayer`, for production Aptos.
 *
 * Consumers who need tighter control (e.g. passing a custom Aptos client
 * or a CCTP contract map) should build their own registry via
 * `makeChainAdapterRegistryLayer` and pass it as `createWallet`'s
 * `chainRegistry` override.
 */
export const ChainAdapterRegistryLive = Layer.effect(
  ChainAdapterRegistry,
  Effect.gen(function* () {
    const configService = yield* WalletConfigService
    const fetcher = yield* FetchAdapter
    const cctpContractMap = configService.config.cctp.contractAddresses

    const adapters = new Map<ChainId, ChainAdapter>()
    for (const chain of configService.config.chains) {
      switch (chain.kind) {
        case "evm": {
          const cctp = cctpContractMap[chain.chainId]
          adapters.set(
            chain.chainId,
            makeEvmChainAdapter({
              chainConfig: chain,
              fetcher,
              cctpContracts: cctp
                ? {
                    tokenMessenger: cctp.tokenMessenger as `0x${string}`,
                    messageTransmitter: cctp.messageTransmitter as `0x${string}`,
                    usdcToken: cctp.usdcToken as `0x${string}`,
                    version: cctp.version,
                  }
                : undefined,
            }),
          )
          break
        }
        case "solana": {
          const cctp = cctpContractMap[chain.chainId]
          adapters.set(
            chain.chainId,
            makeSolanaChainAdapter({
              chainConfig: chain,
              fetcher,
              cctpContracts: cctp
                ? {
                    tokenMessengerMinterProgramId: cctp.tokenMessenger,
                    messageTransmitterProgramId: cctp.messageTransmitter,
                    usdcMint: cctp.usdcToken,
                  }
                : undefined,
            }),
          )
          break
        }
        case "aptos": {
          // Aptos requires a caller-constructed SDK client. Loudly
          // signal the silent fallback so nothing ships to prod
          // thinking it has a real Aptos adapter wired up.
          // eslint-disable-next-line no-console
          console.warn(
            `[wallet-core] ChainAdapterRegistryLive: chain "${String(
              chain.chainId,
            )}" has kind "aptos" but no Aptos client was supplied — falling back to makeMockChainAdapter. Use makeAptosAwareRegistryLive(aptosClients) for a real Aptos adapter.`,
          )
          adapters.set(chain.chainId, makeMockChainAdapter(chain))
          break
        }
        case "mock":
        default: {
          adapters.set(chain.chainId, makeMockChainAdapter(chain))
          break
        }
      }
    }

    return {
      get: (chainId) => {
        const adapter = adapters.get(chainId)
        return adapter
          ? Effect.succeed(adapter)
          : Effect.fail(new UnsupportedChainError({ chain: String(chainId) }))
      },
      supported: () => Array.from(adapters.keys()),
    }
  }),
)

/**
 * Build a registry layer with full Aptos support. Consumers provide a
 * pre-configured `Aptos` client per Aptos chain id — the adapter delegates
 * all HTTP to that client.
 *
 * `sponsoredChains` marks Aptos chain ids whose adapter should be built in
 * sponsored (gas-station) mode. The matching `Aptos` client MUST have been
 * constructed with a `GasStationTransactionSubmitter` wired into
 * `pluginSettings.TRANSACTION_SUBMITTER`; see `AptosAdapterOptions.sponsored`.
 */
export const makeAptosAwareRegistryLive = (
  aptosClients: ReadonlyMap<ChainId, Aptos>,
  sponsoredChains?: ReadonlySet<ChainId>,
): Layer.Layer<
  ChainAdapterRegistry,
  never,
  WalletConfigService | FetchAdapter
> =>
  Layer.effect(
    ChainAdapterRegistry,
    Effect.gen(function* () {
      const configService = yield* WalletConfigService
      const fetcher = yield* FetchAdapter
      const cctpContractMap = configService.config.cctp.contractAddresses

      const adapters = new Map<ChainId, ChainAdapter>()
      for (const chain of configService.config.chains) {
        switch (chain.kind) {
          case "evm": {
            const cctp = cctpContractMap[chain.chainId]
            adapters.set(
              chain.chainId,
              makeEvmChainAdapter({
                chainConfig: chain,
                fetcher,
                cctpContracts: cctp
                  ? {
                      tokenMessenger: cctp.tokenMessenger as `0x${string}`,
                      messageTransmitter: cctp.messageTransmitter as `0x${string}`,
                      usdcToken: cctp.usdcToken as `0x${string}`,
                    }
                  : undefined,
              }),
            )
            break
          }
          case "solana": {
            const cctp = cctpContractMap[chain.chainId]
            adapters.set(
              chain.chainId,
              makeSolanaChainAdapter({
                chainConfig: chain,
                fetcher,
                cctpContracts: cctp
                  ? {
                      tokenMessengerMinterProgramId: cctp.tokenMessenger,
                      messageTransmitterProgramId: cctp.messageTransmitter,
                      usdcMint: cctp.usdcToken,
                    }
                  : undefined,
              }),
            )
            break
          }
          case "aptos": {
            const client = aptosClients.get(chain.chainId)
            if (!client) {
              adapters.set(chain.chainId, makeMockChainAdapter(chain))
              break
            }
            const cctp = cctpContractMap[chain.chainId]
            // When the caller ships no per-chain CCTP config at all,
            // fall back to Circle's mainnet Move-script bundle so
            // EVM/Solana → Aptos mints work out of the box. Callers on
            // testnet MUST supply `APTOS_CCTP_V1_TESTNET` explicitly —
            // the scripts embed different Circle package addresses per
            // network, and we can't infer testnet from `chain.chainId`
            // alone. Once any `cctp` entry exists we respect exactly
            // what the caller passed: mixing bundled mainnet bytecode
            // with a testnet USDC override would fail on-chain.
            const cctpContracts = cctp
              ? {
                  usdcTokenAddress: cctp.usdcToken,
                  depositForBurnScript:
                    cctp.aptosScriptBytecode?.depositForBurn,
                  depositForBurnWithCallerScript:
                    cctp.aptosScriptBytecode?.depositForBurnWithCaller,
                  handleReceiveMessageScript:
                    cctp.aptosScriptBytecode?.handleReceiveMessage,
                }
              : chain.chainId === "aptos"
                ? APTOS_CCTP_V1_MAINNET
                : undefined
            adapters.set(
              chain.chainId,
              makeAptosChainAdapter({
                chainConfig: chain,
                aptosClient: client,
                sponsored: sponsoredChains?.has(chain.chainId) ?? false,
                cctpContracts,
              }),
            )
            break
          }
          case "mock":
          default:
            adapters.set(chain.chainId, makeMockChainAdapter(chain))
            break
        }
      }
      return {
        get: (chainId) => {
          const adapter = adapters.get(chainId)
          return adapter
            ? Effect.succeed(adapter)
            : Effect.fail(new UnsupportedChainError({ chain: String(chainId) }))
        },
        supported: () => Array.from(adapters.keys()),
      }
    }),
  )

// Re-export ChainConfig for consumers building adapters directly.
export type { ChainConfig }

/**
 * Build a ChainAdapterRegistry layer from a pre-built map of adapters.
 * Useful in tests where the mock adapters need to be seeded with balances
 * before the registry is composed into the wallet Layer.
 */
export const makeChainAdapterRegistryLayer = (
  adapters: ReadonlyMap<ChainId, ChainAdapter>,
): Layer.Layer<ChainAdapterRegistry> =>
  Layer.succeed(ChainAdapterRegistry, {
    get: (chainId) => {
      const adapter = adapters.get(chainId)
      return adapter
        ? Effect.succeed(adapter)
        : Effect.fail(new UnsupportedChainError({ chain: String(chainId) }))
    },
    supported: () => Array.from(adapters.keys()),
  })
