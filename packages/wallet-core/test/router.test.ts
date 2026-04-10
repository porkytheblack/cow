import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { KeyringService } from "../src/services/keyring.js"
import { RouterService } from "../src/services/router.js"
import type { AssetId } from "../src/model/asset.js"
import { makeTestHarness } from "./helpers/test-layers.js"

const USDC_APTOS: AssetId = {
  chain: "aptos",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xusdc",
}

const USDC_EVM: AssetId = {
  chain: "evm:1",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xusdc",
}

describe("RouterService", () => {
  it("produces a single direct-transfer step for same-chain intents", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const router = yield* RouterService
      const { keys } = yield* keyring.generate()
      const aptosKey = keys.find((k) => k.chain === "aptos")!
      return yield* router.plan({
        from: { chain: "aptos", address: aptosKey.address },
        to: { chain: "aptos", address: "0xdeadbeef" },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
    })
    const plan = await Effect.runPromise(Effect.provide(program, layer))
    expect(plan.isCrossChain).toBe(false)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.type).toBe("direct-transfer")
  })

  it("produces burn + mint placeholder steps for cross-chain USDC", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const router = yield* RouterService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const dst = keys.find((k) => k.chain === "evm:1")!
      return yield* router.plan({
        from: { chain: "aptos", address: src.address },
        to: { chain: "evm:1", address: dst.address },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
    })
    const plan = await Effect.runPromise(Effect.provide(program, layer))
    expect(plan.isCrossChain).toBe(true)
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]!.type).toBe("cctp-burn")
    expect(plan.steps[1]!.type).toBe("cctp-mint")
  })

  it("rejects cross-chain non-USDC routes with UnsupportedRouteError", async () => {
    const { layer } = makeTestHarness()
    const SOL_NATIVE: AssetId = {
      chain: "solana",
      type: "native",
      symbol: "SOL",
      decimals: 9,
    }
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const router = yield* RouterService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "solana")!
      return yield* router.plan({
        from: { chain: "solana", address: src.address },
        to: { chain: "evm:1", address: "0xdeadbeef" },
        asset: SOL_NATIVE,
        amount: 1_000_000_000n,
      })
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("UnsupportedRouteError")
    }
  })
})
