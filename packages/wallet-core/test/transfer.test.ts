import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { KeyringService } from "../src/services/keyring.js"
import { TransferService } from "../src/services/transfer.js"
import type { AssetId } from "../src/model/asset.js"
import { makeTestHarness } from "./helpers/test-layers.js"

const USDC_APTOS: AssetId = {
  chain: "aptos",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xusdc",
}

describe("TransferService", () => {
  it("executes a same-chain transfer end to end", async () => {
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      harness.seed(src.address, USDC_APTOS, 100_000_000n)
      const result = yield* transfer.execute({
        from: { chain: "aptos", address: src.address },
        to: { chain: "aptos", address: "0xdeadbeef" },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
      return result
    })
    const result = await Effect.runPromise(Effect.provide(program, harness.layer))
    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.receipt?.status).toBe("confirmed")
  })

  it("fails with InsufficientBalanceError when source is underfunded", async () => {
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      // Don't seed any balance.
      return yield* transfer.execute({
        from: { chain: "aptos", address: src.address },
        to: { chain: "aptos", address: "0xdeadbeef" },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, harness.layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("InsufficientBalanceError")
    }
  })

  it("executes a cross-chain CCTP transfer end to end", async () => {
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const dst = keys.find((k) => k.chain === "evm:1")!
      harness.seed(src.address, USDC_APTOS, 100_000_000n)
      const result = yield* transfer.execute({
        from: { chain: "aptos", address: src.address },
        to: { chain: "evm:1", address: dst.address },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
      return result
    })
    const result = await Effect.runPromise(Effect.provide(program, harness.layer))
    expect(result.status).toBe("completed")
    // 1 completed step (the burn+attest+mint compressed into one record).
    expect(result.steps.length).toBeGreaterThanOrEqual(1)
    expect(result.steps[0]!.receipt?.status).toBe("confirmed")
  })
})
