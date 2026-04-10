import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { KeyringService } from "../src/services/keyring.js"
import { makeTestHarness } from "./helpers/test-layers.js"

describe("KeyringService", () => {
  it("generates a mnemonic and derives keys for every configured chain", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const { mnemonic, keys } = yield* keyring.generate()
      return { mnemonic, keys }
    })
    const { mnemonic, keys } = await Effect.runPromise(
      Effect.provide(program, layer),
    )
    expect(mnemonic.phrase.split(" ").length).toBe(12)
    expect(keys).toHaveLength(3)
    const chainIds = keys.map((k) => k.chain)
    expect(chainIds).toEqual(expect.arrayContaining(["aptos", "solana", "evm:1"]))
    // Every address should be non-empty and chain-prefixed where applicable.
    for (const k of keys) {
      expect(k.address.length).toBeGreaterThan(0)
      expect(k.publicKey.length).toBeGreaterThan(0)
    }
  })

  it("import from mnemonic produces deterministic addresses", async () => {
    const { layer } = makeTestHarness()
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      return yield* keyring.importMnemonic(phrase)
    })
    const firstRun = await Effect.runPromise(Effect.provide(program, layer))
    const secondHarness = makeTestHarness()
    const secondRun = await Effect.runPromise(
      Effect.provide(program, secondHarness.layer),
    )
    expect(firstRun.map((k) => k.address)).toEqual(secondRun.map((k) => k.address))
  })

  it("round-trips through exportEncrypted / importEncrypted", async () => {
    const { layer } = makeTestHarness()
    const encKey = new Uint8Array(32).fill(0x42)
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const { keys: original } = yield* keyring.generate()
      const bundle = yield* keyring.exportEncrypted(encKey)
      const restored = yield* keyring.importEncrypted(bundle, encKey)
      return { original, restored }
    })
    const { original, restored } = await Effect.runPromise(
      Effect.provide(program, layer),
    )
    expect(restored.map((k) => k.address)).toEqual(
      original.map((k) => k.address),
    )
  })

  it("rejects import of an invalid mnemonic", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      return yield* keyring.importMnemonic("definitely not a real mnemonic phrase")
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
  })
})
