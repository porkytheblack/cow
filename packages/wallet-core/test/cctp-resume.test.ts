import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { CctpService } from "../src/services/cctp.js"
import { KeyringService } from "../src/services/keyring.js"
import { TransferService } from "../src/services/transfer.js"
import type { PendingCctpTransfer } from "../src/model/cctp.js"
import type { AssetId } from "../src/model/asset.js"
import { makeTestHarness } from "./helpers/test-layers.js"

const USDC_APTOS: AssetId = {
  chain: "aptos",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xusdc",
}

describe("CctpService persistence + resume", () => {
  it("save + load round-trips a pending CCTP transfer", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const cctp = yield* CctpService
      const pending: PendingCctpTransfer = {
        id: "t1",
        planId: "p1",
        status: "awaiting-attestation",
        burn: {
          sourceDomain: 9,
          destDomain: 0,
          nonce: 42n,
          burnTxHash: "0xbeef",
          messageBytes: new Uint8Array([1, 2, 3, 4]),
          messageHash: "deadbeef",
        },
        createdAt: 1,
        updatedAt: 2,
      }
      yield* cctp.savePending(pending)
      const loaded = yield* cctp.loadPending()
      return loaded
    })
    const loaded = await Effect.runPromise(Effect.provide(program, layer))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.id).toBe("t1")
    expect(loaded[0]!.status).toBe("awaiting-attestation")
    expect(loaded[0]!.burn?.nonce).toBe(42n)
    expect(Array.from(loaded[0]!.burn!.messageBytes!)).toEqual([1, 2, 3, 4])
  })

  it("resumePending waits for attestation and submits the mint", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const cctp = yield* CctpService
      const { keys } = yield* keyring.generate()
      const dst = keys.find((k) => k.chain === "evm:1")!

      // Manually persist a burn as if we'd crashed after submitting the
      // burn tx but before waiting on attestation.
      const pending: PendingCctpTransfer = {
        id: "resume-1",
        planId: "plan-1",
        status: "burning",
        burn: {
          sourceDomain: 9,
          destDomain: 0,
          nonce: 7n,
          burnTxHash: "0xburn",
          messageBytes: new Uint8Array([9, 9, 9]),
          messageHash: "feedface",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      yield* cctp.savePending(pending)

      const result = yield* cctp.resumePending(
        pending.id,
        dst.address,
        "evm:1",
      )
      return result
    })
    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.transfer.status).toBe("completed")
    expect(result.transfer.attestation).toBeDefined()
    expect(result.mintReceipt.status).toBe("confirmed")
  })

  it("buildBurnTx delegates to the source adapter.buildCctpBurnTx", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const cctp = yield* CctpService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const dst = keys.find((k) => k.chain === "evm:1")!
      return yield* cctp.buildBurnTx({
        sourceChain: "aptos",
        destChain: "evm:1",
        amount: 5_000_000n,
        from: src.address,
        recipient: dst.address,
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, layer))
    expect(tx.chain).toBe("aptos")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("cctp-burn")
    // destDomain matches the evm:1 mainnet domain (0).
    expect(payload.destDomain).toBe(0)
    expect(payload.amount).toBe("5000000")
  })

  it("PendingCctpTransfer stores sourceChain/destChain/recipient for auto-resume", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const cctp = yield* CctpService
      const pending: PendingCctpTransfer = {
        id: "resume-ctx",
        planId: "plan-ctx",
        status: "awaiting-attestation",
        burn: {
          sourceDomain: 9,
          destDomain: 0,
          nonce: 1n,
          burnTxHash: "0xaaa",
          messageBytes: new Uint8Array([1]),
          messageHash: "aabbccdd",
        },
        sourceChain: "aptos",
        destChain: "evm:1",
        recipient: "0xrecipient",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      yield* cctp.savePending(pending)
      const loaded = yield* cctp.loadPending()
      return loaded
    })
    const loaded = await Effect.runPromise(Effect.provide(program, layer))
    expect(loaded[0]!.sourceChain).toBe("aptos")
    expect(loaded[0]!.destChain).toBe("evm:1")
    expect(loaded[0]!.recipient).toBe("0xrecipient")
  })

  it("resumePending reconciles a `burning` record with no messageBytes via extractBurnMessageFromTx", async () => {
    // Simulates: we saved a `burning` record pre-broadcast, then
    // crashed or the user closed the tab. The record has only
    // `burnTxHash` — no messageBytes / messageHash. Resume should
    // probe the source chain, fill in the burn, and complete the
    // flow end-to-end.
    const USDC_APTOS: AssetId = {
      chain: "aptos",
      type: "token",
      symbol: "USDC",
      decimals: 6,
      address: "0xusdc",
    }
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const cctp = yield* CctpService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const dst = keys.find((k) => k.chain === "evm:1")!
      harness.seed(src.address, USDC_APTOS, 100_000_000n)

      // Drive a real burn through execute so a receipt is recorded in
      // the mock adapter — extractBurnMessageFromTx can then find it.
      // (We can't easily synth a burn tx by hand for a real chain
      // adapter, so we rely on a successful flow to leave the state
      // the resume path needs.)
      yield* transfer.execute({
        from: { chain: "aptos", address: src.address },
        to: { chain: "evm:1", address: dst.address },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })

      // Grab the burn hash from the completed record, then drop the
      // post-reconciliation fields to simulate a "burning" record
      // that never got past save-before-broadcast.
      const post = yield* cctp.loadPending()
      const burnHash = post[0]!.burn!.burnTxHash
      const stub: PendingCctpTransfer = {
        id: "resume-burning",
        planId: "plan-burning",
        status: "burning",
        burn: {
          sourceDomain: 0,
          destDomain: 0,
          nonce: 0n,
          burnTxHash: burnHash,
        },
        sourceChain: "aptos",
        destChain: "evm:1",
        recipient: dst.address,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      yield* cctp.savePending(stub)

      const result = yield* cctp.resumePending(stub.id)
      return result
    })
    const result = await Effect.runPromise(Effect.provide(program, harness.layer))
    expect(result.transfer.status).toBe("completed")
    expect(result.transfer.burn?.messageBytes).toBeDefined()
    expect(result.mintReceipt.status).toBe("confirmed")
  })

  it("updatePending applies a shallow patch without round-tripping the whole record", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const cctp = yield* CctpService
      const pending: PendingCctpTransfer = {
        id: "patch-target",
        planId: "plan-patch",
        status: "burning",
        burn: {
          sourceDomain: 9,
          destDomain: 0,
          nonce: 0n,
          burnTxHash: "0xabc",
        },
        createdAt: 100,
        updatedAt: 100,
      }
      yield* cctp.savePending(pending)
      yield* cctp.updatePending("patch-target", {
        status: "failed",
        updatedAt: 200,
      })
      const loaded = yield* cctp.loadPending()
      return loaded
    })
    const loaded = await Effect.runPromise(Effect.provide(program, layer))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.status).toBe("failed")
    expect(loaded[0]!.updatedAt).toBe(200)
    expect(loaded[0]!.burn?.burnTxHash).toBe("0xabc")
  })

  it("resumePending works without explicit recipient/destChain when stored in the record", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const cctp = yield* CctpService
      const { keys } = yield* keyring.generate()
      const dst = keys.find((k) => k.chain === "evm:1")!

      const pending: PendingCctpTransfer = {
        id: "auto-resume",
        planId: "plan-auto",
        status: "burning",
        burn: {
          sourceDomain: 9,
          destDomain: 0,
          nonce: 7n,
          burnTxHash: "0xburn",
          messageBytes: new Uint8Array([9, 9, 9]),
          messageHash: "feedface",
        },
        destChain: "evm:1",
        recipient: dst.address,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      yield* cctp.savePending(pending)

      // Resume without passing recipient/destChain — reads from record.
      const result = yield* cctp.resumePending(pending.id)
      return result
    })
    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.transfer.status).toBe("completed")
    expect(result.mintReceipt.status).toBe("confirmed")
  })
})
