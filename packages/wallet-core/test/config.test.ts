import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { WalletConfigService, makeWalletConfigLayer } from "../src/config/index.js"
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
})
