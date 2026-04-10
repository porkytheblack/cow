import { Effect, Layer, Ref } from "effect"
import { StorageAdapter } from "./index.js"

/**
 * InMemoryStorageAdapter — per-instance Map-backed storage. Primarily for
 * tests, but safe to use as a default when callers don't care about
 * persistence (e.g. ephemeral dev environments).
 */
export const InMemoryStorageAdapter = Layer.effect(
  StorageAdapter,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, Uint8Array>>(new Map())
    return {
      save: (key, value) =>
        Ref.update(store, (m) => {
          const next = new Map(m)
          next.set(key, value)
          return next
        }),
      load: (key) =>
        Effect.map(Ref.get(store), (m) => m.get(key) ?? null),
      delete: (key) =>
        Ref.update(store, (m) => {
          const next = new Map(m)
          next.delete(key)
          return next
        }),
      list: (prefix) =>
        Effect.map(Ref.get(store), (m) =>
          Array.from(m.keys()).filter((k) => k.startsWith(prefix)),
        ),
    }
  }),
)
