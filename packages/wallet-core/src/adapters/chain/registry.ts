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
 *   - "aptos"  -> falls back to mock unless an Aptos client is supplied
 *                 via `aptosClients` — use `makeChainAdapterRegistryLayer`
 *                 with `makeAptosChainAdapter` for full Aptos support.
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
                  }
                : undefined,
            }),
          )
          break
        }
        case "solana": {
          adapters.set(
            chain.chainId,
            makeSolanaChainAdapter({ chainConfig: chain, fetcher }),
          )
          break
        }
        case "aptos":
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
 */
export const makeAptosAwareRegistryLive = (
  aptosClients: ReadonlyMap<ChainId, Aptos>,
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
          case "solana":
            adapters.set(
              chain.chainId,
              makeSolanaChainAdapter({ chainConfig: chain, fetcher }),
            )
            break
          case "aptos": {
            const client = aptosClients.get(chain.chainId)
            if (!client) {
              adapters.set(chain.chainId, makeMockChainAdapter(chain))
              break
            }
            adapters.set(
              chain.chainId,
              makeAptosChainAdapter({ chainConfig: chain, aptosClient: client }),
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
