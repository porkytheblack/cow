import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { createWallet } from "../src/create-wallet.js"
import { KeyringService } from "../src/services/keyring.js"
import { SignerService } from "../src/services/signer.js"
import { DenyingAuthGate } from "../src/services/auth-gate.js"
import { ChainAdapterRegistry } from "../src/adapters/chain/index.js"
import { makeChainAdapterRegistryLayer } from "../src/adapters/chain/registry.js"
import { makeMockChainAdapter } from "../src/adapters/chain/mock.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import type { ChainId } from "../src/model/chain.js"
import type { ChainAdapter } from "../src/adapters/chain/index.js"
import { testConfig } from "./helpers/test-config.js"
import { makeTestHarness } from "./helpers/test-layers.js"

describe("SignerService", () => {
  it("signs a transaction when auth is approved", async () => {
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: src.address,
        to: "0xdeadbeef",
        asset: { chain: "aptos", type: "token", symbol: "USDC", decimals: 6 },
        amount: 1_000n,
      })
      return yield* signer.sign(tx)
    })
    const signed = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    expect(signed.hash).toBeTypeOf("string")
    expect(signed.raw.length).toBeGreaterThan(0)
  })

  it("propagates AuthDeniedError when the gate denies", async () => {
    // Build a custom wallet with the denying auth gate.
    const adapters = new Map<ChainId, ChainAdapter>()
    for (const chain of testConfig.chains) {
      adapters.set(chain.chainId, makeMockChainAdapter(chain))
    }
    const fetchLayer = makeMockFetchAdapter({ handlers: [], fallbackTo404: true })
    const layer = createWallet(testConfig, {
      authGate: DenyingAuthGate,
      chainRegistry: makeChainAdapterRegistryLayer(adapters),
      fetch: fetchLayer,
    })

    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: src.address,
        to: "0xdeadbeef",
        asset: { chain: "aptos", type: "token", symbol: "USDC", decimals: 6 },
        amount: 1_000n,
      })
      return yield* signer.sign(tx)
    })

    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AuthDeniedError")
    }
  })
})
