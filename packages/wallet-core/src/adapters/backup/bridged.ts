import { Effect, Layer } from "effect"
import { BackupError, BackupDecryptionError } from "../../model/errors.js"
import type { BackupManifest } from "./index.js"
import { BackupAdapter } from "./index.js"
import {
  packBackupFile,
  unpackBackupFile,
} from "./file-export.js"

/**
 * Bridged backup adapter — generic shim that hands the encrypted file
 * off to a consumer-supplied native implementation. This is the pattern
 * iCloud KV / Google Drive / Android ScopedStorage / etc. should use:
 * the wallet library owns the envelope format (via packBackupFile), and
 * the app bridges to the native store via these hooks.
 *
 * Hook contract:
 *
 *   saveFile(file, manifest) -> Promise<void>
 *     Called during exportBackup. `file` is a self-describing blob
 *     containing the magic + manifest + encrypted bundle bytes. The
 *     implementation should write it to the native store (iCloud KV,
 *     Drive app data folder, shared container, etc.) and resolve when
 *     the write is durable.
 *
 *   loadFile() -> Promise<{ file: Uint8Array } | null>
 *     Called during importBackup. The implementation should return the
 *     most recent saved file bytes, or null if no backup exists.
 *
 *   checkStatus() -> Promise<{ exists: boolean; lastBackup?: number }>
 *     Called during status(). Cheap check — the implementation should
 *     query native metadata (e.g. NSUbiquitousKeyValueStore
 *     synchronizeDate) rather than reading the full file.
 */

export interface BridgedBackupHooks {
  readonly provider: string
  readonly saveFile: (file: Uint8Array, manifest: BackupManifest) => Promise<void>
  readonly loadFile: () => Promise<{ file: Uint8Array } | null>
  readonly checkStatus: () => Promise<{ exists: boolean; lastBackup?: number }>
}

/**
 * Build a BackupAdapter layer that delegates IO to the supplied hooks.
 * The layer itself is pure — each operation runs the hook, maps errors
 * into typed BackupError / BackupDecryptionError, and maps successes
 * into decoded manifests.
 */
export const makeBridgedBackupAdapter = (
  hooks: BridgedBackupHooks,
): Layer.Layer<BackupAdapter> =>
  Layer.succeed(BackupAdapter, {
    exportBackup: (bundle, manifest) =>
      Effect.tryPromise({
        try: async () => {
          const file = packBackupFile(bundle, manifest)
          await hooks.saveFile(file, manifest)
        },
        catch: (cause) =>
          new BackupError({
            provider: hooks.provider,
            operation: "export",
            cause,
          }),
      }),

    importBackup: () =>
      Effect.gen(function* () {
        const loaded = yield* Effect.tryPromise({
          try: () => hooks.loadFile(),
          catch: (cause) =>
            new BackupError({
              provider: hooks.provider,
              operation: "import",
              cause,
            }),
        })
        if (!loaded) {
          return yield* Effect.fail(
            new BackupError({
              provider: hooks.provider,
              operation: "import",
              cause: "no backup exists",
            }),
          )
        }
        try {
          const { bundle, manifest } = unpackBackupFile(loaded.file)
          return { bundle, manifest }
        } catch (e) {
          return yield* Effect.fail(
            new BackupDecryptionError({
              message: `unpack failed: ${(e as Error).message}`,
            }),
          )
        }
      }),

    status: () =>
      Effect.tryPromise({
        try: () => hooks.checkStatus(),
        catch: (cause) =>
          new BackupError({
            provider: hooks.provider,
            operation: "status",
            cause,
          }),
      }),
  })

/**
 * iCloud Key-Value Store backup adapter. Takes a caller-provided hook
 * bundle that bridges NSUbiquitousKeyValueStore on iOS via a React
 * Native native module (or CKContainer on SwiftUI / Catalyst).
 *
 * Example hook shape (pseudo-code) on React Native iOS:
 *
 *   const hooks = {
 *     provider: "icloud-kv",
 *     saveFile: async (file, manifest) => {
 *       await NativeModules.ICloudKV.setItem(
 *         "wallet.backup",
 *         base64Encode(file),
 *       )
 *     },
 *     loadFile: async () => {
 *       const b64 = await NativeModules.ICloudKV.getItem("wallet.backup")
 *       return b64 ? { file: base64Decode(b64) } : null
 *     },
 *     checkStatus: async () => {
 *       const info = await NativeModules.ICloudKV.getMetadata("wallet.backup")
 *       return { exists: !!info, lastBackup: info?.updatedAt }
 *     },
 *   }
 */
export const iCloudBackupAdapter = (
  hooks: Omit<BridgedBackupHooks, "provider">,
): Layer.Layer<BackupAdapter> =>
  makeBridgedBackupAdapter({ provider: "icloud-kv", ...hooks })

/**
 * Google Drive backup adapter. Bridges to the consuming app's Drive
 * integration (via `@react-native-google-signin/google-signin` + Drive
 * REST API, or via a web OAuth flow). Same contract as iCloud — the
 * consumer owns the auth and file IO; this adapter owns the envelope.
 */
export const googleDriveBackupAdapter = (
  hooks: Omit<BridgedBackupHooks, "provider">,
): Layer.Layer<BackupAdapter> =>
  makeBridgedBackupAdapter({ provider: "google-drive", ...hooks })
