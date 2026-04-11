import { describe, expect, it, vi } from "vitest"
import { Effect, Layer } from "effect"
import { WalletConfigService, makeWalletConfigLayer } from "../src/config/index.js"
import { ChainAdapterRegistry } from "../src/adapters/chain/index.js"
import { ChainAdapterRegistryLive } from "../src/adapters/chain/registry.js"
import { FetchAdapter } from "../src/adapters/fetch/index.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import type { ChainConfig } from "../src/model/chain.js"
import { testConfig } from "./helpers/test-config.js"

describe("WalletConfigService", () => {
  it("returns the configured chain for a known chainId", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* WalletConfigService
      return yield* svc.getChain("aptos")
    })
    const chain = await Effect.runPromise(
      Effect.provide(program, makeWalletConfigLayer(testConfig)),
    )
    expect(chain.chainId).toBe("aptos")
    expect(chain.rpcUrl).toBe("mock://aptos")
  })

  it("fails with UnsupportedChainError for an unknown chainId", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* WalletConfigService
      return yield* svc.getChain("unknown-chain")
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, makeWalletConfigLayer(testConfig))),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("UnsupportedChainError")
    }
  })

  it("ChainAdapterRegistryLive warns when falling back to the mock for aptos", async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const aptosConfig: ChainConfig = {
      chainId: "aptos",
      name: "Aptos",
      rpcUrl: "mock://aptos",
      kind: "aptos",
      cctpDomain: 9,
      nativeAsset: {
        chain: "aptos",
        type: "native",
        symbol: "APT",
        decimals: 8,
      },
    }
    const layer = ChainAdapterRegistryLive.pipe(
      Layer.provide(makeWalletConfigLayer({
        chains: [aptosConfig],
        cctp: {
          attestationApiUrl: "mock://iris",
          contractAddresses: {},
          attestationPollIntervalMs: 10,
          attestationTimeoutMs: 100,
        },
        auth: { elevatedThreshold: 0n, sessionTtlMs: 1000, pinMinLength: 4 },
        keyring: { mnemonicStrength: 128, derivationPaths: {} },
      })),
      Layer.provide(makeMockFetchAdapter({ handlers: [], fallbackTo404: true })),
    )
    const program = Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      return registry.supported()
    })
    const supported = await Effect.runPromise(Effect.provide(program, layer))
    expect(supported).toContain("aptos")
    expect(warnSpy).toHaveBeenCalled()
    const msg = warnSpy.mock.calls[0]![0] as string
    expect(msg).toContain("aptos")
    expect(msg).toContain("makeAptosAwareRegistryLive")
    warnSpy.mockRestore()
  })
})
