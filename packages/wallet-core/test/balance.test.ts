import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { BalanceService } from "../src/services/balance.js"
import { KeyringService } from "../src/services/keyring.js"
import type { AssetId } from "../src/model/asset.js"
import { makeTestHarness } from "./helpers/test-layers.js"

describe("BalanceService", () => {
  it("returns zero for an unseeded address", async () => {
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const balance = yield* BalanceService
      const { keys } = yield* keyring.generate()
      const aptos = keys.find((k) => k.chain === "aptos")!
      const asset: AssetId = {
        chain: "aptos",
        type: "token",
        symbol: "USDC",
        decimals: 6,
      }
      return yield* balance.getBalance("aptos", aptos.address, asset)
    })
    const result = await Effect.runPromise(Effect.provide(program, harness.layer))
    expect(result.balance).toBe(0n)
  })

  it("aggregates a portfolio across all chains", async () => {
    const harness = makeTestHarness()
    const USDC_APT: AssetId = {
      chain: "aptos",
      type: "token",
      symbol: "USDC",
      decimals: 6,
    }
    const USDC_EVM: AssetId = {
      chain: "evm:1",
      type: "token",
      symbol: "USDC",
      decimals: 6,
    }
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const balance = yield* BalanceService
      const { keys } = yield* keyring.generate()
      const aptos = keys.find((k) => k.chain === "aptos")!
      const evm = keys.find((k) => k.chain === "evm:1")!
      harness.seed(aptos.address, USDC_APT, 5_000_000n)
      harness.seed(evm.address, USDC_EVM, 7_000_000n)
      return yield* balance.getPortfolio(keys)
    })
    const portfolio = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    const total = portfolio.balances.reduce((acc, b) => acc + b.balance, 0n)
    expect(total).toBe(12_000_000n)
  })
})
