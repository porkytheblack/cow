import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AuthGateService } from "../src/services/auth-gate.js"
import { makeCallbackAuthGate } from "../src/services/auth-gate-callback.js"

describe("makeCallbackAuthGate", () => {
  it("resolves requestApproval when the hook returns an AuthApproval", async () => {
    const layer = makeCallbackAuthGate({
      promptApproval: async (req) => ({
        method: req.requiredLevel === "elevated" ? "passkey" : "pin",
        timestamp: 123,
      }),
      getEncryptionKey: async () => new Uint8Array(32).fill(7),
    })
    const program = Effect.gen(function* () {
      const gate = yield* AuthGateService
      return yield* gate.requestApproval({
        reason: "send",
        requiredLevel: "standard",
      })
    })
    const approval = await Effect.runPromise(Effect.provide(program, layer))
    expect(approval.method).toBe("pin")
    expect(approval.timestamp).toBe(123)
  })

  it("fails with AuthDeniedError when the hook returns null", async () => {
    const layer = makeCallbackAuthGate({
      promptApproval: async () => null,
      getEncryptionKey: async () => new Uint8Array(32),
    })
    const program = Effect.gen(function* () {
      const gate = yield* AuthGateService
      return yield* gate.requestApproval({
        reason: "send",
        requiredLevel: "standard",
      })
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AuthDeniedError")
    }
  })

  it("fails with AuthTimeoutError when the hook never resolves", async () => {
    const layer = makeCallbackAuthGate({
      promptApproval: () => new Promise(() => undefined),
      getEncryptionKey: async () => new Uint8Array(32),
      timeoutMs: 50,
    })
    const program = Effect.gen(function* () {
      const gate = yield* AuthGateService
      return yield* gate.requestApproval({
        reason: "send",
        requiredLevel: "standard",
      })
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AuthTimeoutError")
    }
  })

  it("returns the encryption key from getEncryptionKey", async () => {
    const layer = makeCallbackAuthGate({
      promptApproval: async () => ({ method: "pin", timestamp: 0 }),
      getEncryptionKey: async () => new Uint8Array(32).fill(0xab),
    })
    const program = Effect.gen(function* () {
      const gate = yield* AuthGateService
      return yield* gate.deriveEncryptionKey()
    })
    const key = await Effect.runPromise(Effect.provide(program, layer))
    expect(key.length).toBe(32)
    expect(key[0]).toBe(0xab)
  })
})
