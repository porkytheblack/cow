import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { CctpService } from "../src/services/cctp.js"
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

  it("recovers when the burn broadcast errors but the tx landed on-chain", async () => {
    // Reproduces the Solana sendTransaction preflight race: the RPC
    // returns an error, but the cluster accepted + executed the burn.
    // Pre-fix behavior: no pending record, user funds stuck. Post-fix:
    // extractBurnMessageFromTx probes the chain, finds the burn, the
    // transfer proceeds through attestation + mint normally.
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const cctp = yield* CctpService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const dst = keys.find((k) => k.chain === "evm:1")!
      harness.seed(src.address, USDC_APTOS, 100_000_000n)

      // Next broadcast on the source chain rejects, but leaves a
      // receipt behind — simulating a landed-despite-error tx.
      harness.seedBroadcast("aptos", {
        reject: true,
        landReceiptAnyway: true,
      })

      const result = yield* transfer.execute({
        from: { chain: "aptos", address: src.address },
        to: { chain: "evm:1", address: dst.address },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
      const pending = yield* cctp.loadPending()
      return { result, pending }
    })
    const { result, pending } = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    expect(result.status).toBe("completed")
    expect(result.steps[0]!.receipt?.status).toBe("confirmed")
    // A single pending record was created pre-broadcast and advanced
    // all the way to "completed" — no orphan record left behind.
    expect(pending).toHaveLength(1)
    expect(pending[0]!.status).toBe("completed")
    expect(pending[0]!.burn?.messageBytes).toBeDefined()
    expect(pending[0]!.attestation).toBeDefined()
  })

  it("marks the pending record failed when broadcast truly failed", async () => {
    // Complement to the above: broadcast rejected AND the tx did NOT
    // land. Reconciliation returns null; the record must be marked
    // `failed` and the original BroadcastError must propagate so the
    // caller can retry safely.
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const cctp = yield* CctpService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const dst = keys.find((k) => k.chain === "evm:1")!
      harness.seed(src.address, USDC_APTOS, 100_000_000n)

      harness.seedBroadcast("aptos", {
        reject: true,
        landReceiptAnyway: false,
      })

      const result = yield* Effect.either(
        transfer.execute({
          from: { chain: "aptos", address: src.address },
          to: { chain: "evm:1", address: dst.address },
          asset: USDC_APTOS,
          amount: 10_000_000n,
        }),
      )
      const pending = yield* cctp.loadPending()
      return { result, pending }
    })
    const { result, pending } = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
    }
    expect(pending).toHaveLength(1)
    expect(pending[0]!.status).toBe("failed")
    // Hash was captured pre-broadcast so a human can investigate.
    expect(pending[0]!.burn?.burnTxHash).toBeTruthy()
  })
})
