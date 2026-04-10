import { Effect, Layer } from "effect"
import { WalletConfigService } from "../../config/index.js"
import type { ChainId } from "../../model/chain.js"
import { UnsupportedChainError } from "../../model/errors.js"
import { FetchAdapter } from "../fetch/index.js"
import type { ChainAdapter } from "./index.js"
import { ChainAdapterRegistry } from "./index.js"
import { makeMockChainAdapter } from "./mock.js"

/**
 * Live ChainAdapterRegistry layer.
 *
 * Reads `WalletConfigService` and instantiates one adapter per configured
 * chain. The `kind` field on each ChainConfig selects the implementation:
 *
 *   - "mock"   -> makeMockChainAdapter (in-memory, deterministic)
 *   - "aptos"  -> real Aptos adapter  (deferred — see ARCHITECTURE.md §11.15)
 *   - "solana" -> real Solana adapter (deferred)
 *   - "evm"    -> real EVM adapter    (deferred)
 *
 * Until the real adapters land, "aptos"/"solana"/"evm" fall through to the
 * mock implementation. This keeps the integration surface stable and lets
 * downstream services be tested end-to-end today.
 */
export const ChainAdapterRegistryLive = Layer.effect(
  ChainAdapterRegistry,
  Effect.gen(function* () {
    const configService = yield* WalletConfigService
    // FetchAdapter is reserved for real chain adapters; mock adapters don't
    // need it, but we yield it here so the dependency is declared.
    const _fetcher = yield* FetchAdapter
    void _fetcher

    const adapters = new Map<ChainId, ChainAdapter>()
    for (const chain of configService.config.chains) {
      // TODO: once real adapters ship, dispatch on chain.kind:
      //   case "aptos":  adapters.set(chain.chainId, makeAptosAdapter(chain, fetcher))
      //   case "solana": adapters.set(chain.chainId, makeSolanaAdapter(chain, fetcher))
      //   case "evm":    adapters.set(chain.chainId, makeEvmAdapter(chain, fetcher))
      adapters.set(chain.chainId, makeMockChainAdapter(chain))
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
