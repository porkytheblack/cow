import { Effect, Layer } from "effect"
import { StorageError } from "../../model/errors.js"
import { StorageAdapter } from "./index.js"

/**
 * SecureStorageAdapter — bridged-pattern adapter for native secure
 * storage (React Native Keychain/Keystore, iOS Keychain via
 * `react-native-keychain`, Android EncryptedSharedPreferences /
 * Keystore, browser IndexedDB behind Web Crypto, etc.).
 *
 * The wallet library owns the key-namespacing and serialisation; the
 * consumer owns the native binding. All values cross the bridge as
 * byte arrays — implementations should base64-encode on the way in
 * and decode on the way out if their underlying store is string-only.
 *
 * Hook contract (every call returns a Promise):
 *
 *   save(key, value)    — persist the bytes atomically.
 *   load(key)           — return the bytes, or null if absent.
 *   delete(key)         — remove the entry; idempotent.
 *   list(prefix)        — enumerate keys with the given prefix. Used
 *                         by KeyringService to find stored keypair
 *                         records. Implementations that can't
 *                         enumerate should maintain a local index
 *                         under a well-known key.
 *
 * Any exception (network, permission, locked device) is mapped into
 * a typed `StorageError` with the underlying cause attached.
 */

export interface SecureStoreHooks {
  readonly save: (key: string, value: Uint8Array) => Promise<void>
  readonly load: (key: string) => Promise<Uint8Array | null>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix: string) => Promise<readonly string[]>
}

const wrap =
  <T>(
    operation: "read" | "write" | "delete" | "list",
    key: string,
    fn: () => Promise<T>,
  ): Effect.Effect<T, StorageError> =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) => new StorageError({ operation, key, cause }),
    })

/**
 * Build a `StorageAdapter` layer that delegates every operation to
 * caller-supplied native hooks. The layer itself is pure — hook errors
 * bubble up as typed `StorageError`s.
 */
export const makeSecureStorageAdapter = (
  hooks: SecureStoreHooks,
): Layer.Layer<StorageAdapter> =>
  Layer.succeed(StorageAdapter, {
    save: (key, value) => wrap("write", key, () => hooks.save(key, value)),
    load: (key) => wrap("read", key, () => hooks.load(key)),
    delete: (key) => wrap("delete", key, () => hooks.delete(key)),
    list: (prefix) => wrap("list", prefix, () => hooks.list(prefix)),
  })

/**
 * Convenience factory for React Native Keychain-style stores that
 * work with string values only. Handles the base64 round-trip so the
 * hooks can ignore bytes.
 */
export interface StringBackedSecureStoreHooks {
  readonly save: (key: string, valueBase64: string) => Promise<void>
  readonly load: (key: string) => Promise<string | null>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix: string) => Promise<readonly string[]>
}

const base64Encode = (bytes: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const btoa = (globalThis as any).btoa as ((v: string) => string) | undefined
  if (!btoa) throw new Error("btoa unavailable in this runtime")
  return btoa(s)
}

const base64Decode = (value: string): Uint8Array => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atob = (globalThis as any).atob as ((v: string) => string) | undefined
  if (!atob) throw new Error("atob unavailable in this runtime")
  const s = atob(value)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export const makeStringSecureStorageAdapter = (
  hooks: StringBackedSecureStoreHooks,
): Layer.Layer<StorageAdapter> =>
  makeSecureStorageAdapter({
    save: (key, value) => hooks.save(key, base64Encode(value)),
    load: async (key) => {
      const v = await hooks.load(key)
      return v === null ? null : base64Decode(v)
    },
    delete: (key) => hooks.delete(key),
    list: (prefix) => hooks.list(prefix),
  })
