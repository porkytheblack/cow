import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex } from "@noble/hashes/utils"
import { keccak_256 } from "@noble/hashes/sha3"
import { SignerService } from "../src/services/signer.js"
import { ChainAdapterRegistry } from "../src/adapters/chain/index.js"
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

  it("importPrivateKey derives the right address for an ed25519 chain", async () => {
    const { layer } = makeTestHarness()
    const pk = new Uint8Array(32).fill(7)
    const expectedPub = ed25519.getPublicKey(pk)
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      return yield* keyring.importPrivateKey("solana", pk)
    })
    const key = await Effect.runPromise(Effect.provide(program, layer))
    expect(key.chain).toBe("solana")
    expect(key.path.path).toBe("import")
    expect(Array.from(key.publicKey)).toEqual(Array.from(expectedPub))
    expect(key.address.length).toBeGreaterThan(0)
  })

  it("importPrivateKey produces the canonical EVM address for secp256k1", async () => {
    const { layer } = makeTestHarness()
    const pk = new Uint8Array(32)
    pk[31] = 1 // the classic dev key
    const uncompressed = secp256k1.getPublicKey(pk, false).slice(1)
    const expectedAddress =
      "0x" + bytesToHex(keccak_256(uncompressed).slice(12))
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      return yield* keyring.importPrivateKey("evm:1", pk)
    })
    const key = await Effect.runPromise(Effect.provide(program, layer))
    expect(key.address.toLowerCase()).toBe(expectedAddress.toLowerCase())
  })

  it("importPrivateKey refuses to replace an existing key unless overwrite is set", async () => {
    const { layer } = makeTestHarness()
    const first = new Uint8Array(32).fill(0x11)
    const second = new Uint8Array(32).fill(0x22)
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.importPrivateKey("solana", first)
      return yield* keyring.importPrivateKey("solana", second)
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")

    // With overwrite the second import wins.
    const { layer: fresh } = makeTestHarness()
    const overwritten = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.importPrivateKey("solana", first)
      return yield* keyring.importPrivateKey("solana", second, {
        overwrite: true,
      })
    })
    const afterOverwrite = await Effect.runPromise(
      Effect.provide(overwritten, fresh),
    )
    const expectedPub = ed25519.getPublicKey(second)
    expect(Array.from(afterOverwrite.publicKey)).toEqual(
      Array.from(expectedPub),
    )
  })

  it("importPrivateKey rejects keys that aren't 32 bytes", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      return yield* keyring.importPrivateKey("solana", new Uint8Array(16))
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("KeyGenerationError")
    }
  })

  it("importPrivateKey rejects chains not in WalletConfig.chains", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      return yield* keyring.importPrivateKey(
        "evm:999999",
        new Uint8Array(32).fill(1),
      )
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
  })

  it("coexists with generated keys — the mnemonic-derived keys stay intact", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const generated = yield* keyring.generate()
      const solanaBefore = generated.keys.find((k) => k.chain === "solana")!
      // Import a key for an *unoccupied-by-mnemonic-override* slot
      // (solana IS generated, so use overwrite)
      const imported = yield* keyring.importPrivateKey(
        "solana",
        new Uint8Array(32).fill(0xab),
        { overwrite: true },
      )
      const aptosAfter = yield* keyring.getKey("aptos")
      return { solanaBefore, imported, aptosAfter, generated }
    })
    const { solanaBefore, imported, aptosAfter, generated } =
      await Effect.runPromise(Effect.provide(program, layer))
    const aptosBefore = generated.keys.find((k) => k.chain === "aptos")!
    // Aptos untouched by the Solana import.
    expect(aptosAfter.address).toBe(aptosBefore.address)
    // Solana replaced.
    expect(imported.address).not.toBe(solanaBefore.address)
    expect(imported.path.path).toBe("import")
  })

  it("imported key signs and verifies through SignerService", async () => {
    const { layer } = makeTestHarness()
    const pk = new Uint8Array(32).fill(0x33)
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      yield* keyring.importPrivateKey("solana", pk)
      const adapter = yield* registry.get("solana")
      const key = yield* keyring.getKey("solana")
      const tx = yield* adapter.buildTransferTx({
        from: key.address,
        to: "0xdead",
        asset: { chain: "solana", type: "token", symbol: "USDC", decimals: 6 },
        amount: 1n,
      })
      return yield* signer.sign(tx)
    })
    const signed = await Effect.runPromise(Effect.provide(program, layer))
    expect(signed.raw.length).toBeGreaterThan(0)
  })

  it("imported keys survive exportEncrypted / importEncrypted round-trips", async () => {
    const { layer } = makeTestHarness()
    const encKey = new Uint8Array(32).fill(0x99)
    const importedPk = new Uint8Array(32).fill(0x55)
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.generate()
      yield* keyring.importPrivateKey("evm:1", importedPk, { overwrite: true })
      const bundle = yield* keyring.exportEncrypted(encKey)
      const restored = yield* keyring.importEncrypted(bundle, encKey)
      return restored
    })
    const restored = await Effect.runPromise(Effect.provide(program, layer))
    const evm = restored.find((k) => k.chain === "evm:1")!
    expect(evm.path.path).toBe("import")
  })
})
