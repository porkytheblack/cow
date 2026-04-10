import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { StorageAdapter } from "../src/adapters/storage/index.js"
import {
  makeSecureStorageAdapter,
  makeStringSecureStorageAdapter,
} from "../src/adapters/storage/secure-store.js"

describe("SecureStorageAdapter", () => {
  it("proxies save/load/delete/list to the bridge hooks", async () => {
    const store = new Map<string, Uint8Array>()
    const layer = makeSecureStorageAdapter({
      save: async (k, v) => {
        store.set(k, v)
      },
      load: async (k) => store.get(k) ?? null,
      delete: async (k) => {
        store.delete(k)
      },
      list: async (prefix) =>
        Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
    })

    const program = Effect.gen(function* () {
      const storage = yield* StorageAdapter
      yield* storage.save("keyring:alpha", new Uint8Array([1, 2, 3]))
      yield* storage.save("keyring:beta", new Uint8Array([4, 5]))
      yield* storage.save("other:gamma", new Uint8Array([6]))

      const alpha = yield* storage.load("keyring:alpha")
      const missing = yield* storage.load("nope")
      const prefixed = yield* storage.list("keyring:")
      yield* storage.delete("keyring:alpha")
      const afterDelete = yield* storage.load("keyring:alpha")

      return { alpha, missing, prefixed, afterDelete }
    })
    const { alpha, missing, prefixed, afterDelete } = await Effect.runPromise(
      Effect.provide(program, layer),
    )
    expect(alpha && Array.from(alpha)).toEqual([1, 2, 3])
    expect(missing).toBeNull()
    expect(prefixed.slice().sort()).toEqual(["keyring:alpha", "keyring:beta"])
    expect(afterDelete).toBeNull()
  })

  it("maps hook rejections into typed StorageError", async () => {
    const layer = makeSecureStorageAdapter({
      save: async () => {
        throw new Error("keychain locked")
      },
      load: async () => null,
      delete: async () => {},
      list: async () => [],
    })
    const program = Effect.gen(function* () {
      const storage = yield* StorageAdapter
      return yield* storage.save("keyring:x", new Uint8Array([0]))
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("StorageError")
      expect(result.left.operation).toBe("write")
    }
  })

  it("string-backed adapter base64-encodes values across the bridge", async () => {
    const store = new Map<string, string>()
    const layer = makeStringSecureStorageAdapter({
      save: async (k, v) => {
        store.set(k, v)
      },
      load: async (k) => store.get(k) ?? null,
      delete: async (k) => {
        store.delete(k)
      },
      list: async (prefix) =>
        Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
    })

    const program = Effect.gen(function* () {
      const storage = yield* StorageAdapter
      yield* storage.save("k", new Uint8Array([0x42, 0xff, 0x00, 0x01]))
      return yield* storage.load("k")
    })
    const bytes = await Effect.runPromise(Effect.provide(program, layer))
    expect(bytes && Array.from(bytes)).toEqual([0x42, 0xff, 0x00, 0x01])
    // The value stored by the hook itself is base64, not raw bytes.
    expect(store.get("k")).toBe("Qv8AAQ==")
  })
})
