import type { AssetId } from "../../src/model/asset.js"
import type { ChainConfig, ChainId } from "../../src/model/chain.js"
import type { WalletConfig } from "../../src/config/index.js"
import { makeMockFetchAdapter } from "../../src/adapters/fetch/mock.js"
import type { ChainAdapter } from "../../src/adapters/chain/index.js"
import {
  makeChainAdapterRegistryLayer,
} from "../../src/adapters/chain/registry.js"
import { makeMockChainAdapter } from "../../src/adapters/chain/mock.js"
import { createWallet, type WalletLayer } from "../../src/create-wallet.js"
import { testConfig as defaultTestConfig } from "./test-config.js"

export interface TestHarness {
  readonly layer: WalletLayer
  readonly seed: (address: string, asset: AssetId, amount: bigint) => void
  readonly adapters: ReadonlyMap<ChainId, ChainAdapter>
  readonly config: WalletConfig
}

/**
 * Build a complete test wallet harness:
 *
 *   - one mock ChainAdapter per configured chain
 *   - a mock FetchAdapter that returns completed Circle attestations
 *   - in-memory storage + backup
 *   - TestAuthGate (auto-approves)
 *
 * Returns handles to the mock adapters so tests can seed balances before
 * running transfer flows.
 */
export const makeTestHarness = (
  config: WalletConfig = defaultTestConfig,
): TestHarness => {
  const adapters = new Map<ChainId, ChainAdapter>()
  for (const chain of config.chains) {
    adapters.set(chain.chainId, makeMockChainAdapter(chain as ChainConfig))
  }

  const seed = (address: string, asset: AssetId, amount: bigint) => {
    const adapter = adapters.get(asset.chain)
    if (!adapter) throw new Error(`No adapter for chain ${String(asset.chain)}`)
    const seedFn = (adapter as unknown as {
      __seed: (a: string, b: AssetId, c: bigint) => void
    }).__seed
    seedFn(address, asset, amount)
  }

  const chainRegistryLayer = makeChainAdapterRegistryLayer(adapters)

  // Mock fetch that returns a completed Circle attestation immediately.
  const mockFetch = makeMockFetchAdapter({
    handlers: [
      [
        "mock-iris.circle.test",
        () => ({
          status: 200,
          body: {
            messages: [
              {
                status: "complete",
                attestation: "0x" + "ab".repeat(65),
                message: "0x",
                eventNonce: "1",
              },
            ],
          },
        }),
      ],
    ],
    fallbackTo404: true,
  })

  const layer = createWallet(config, {
    chainRegistry: chainRegistryLayer,
    fetch: mockFetch,
  })

  return { layer, seed, adapters, config }
}
