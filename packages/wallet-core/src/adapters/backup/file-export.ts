import { Effect, Layer, Ref } from "effect"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { BackupError, BackupDecryptionError } from "../../model/errors.js"
import type { BackupManifest } from "./index.js"
import { BackupAdapter } from "./index.js"

/**
 * FileExportBackupAdapter — produces an encrypted backup file that the
 * consuming app saves / shares however it wants (download in browser,
 * Share sheet on iOS/Android, blob upload, etc.). This adapter holds the
 * most recent exported bundle in-memory so `importBackup()` can return
 * it without any filesystem dependency.
 *
 * File layout (the bytes this adapter hands to the caller):
 *
 *     0x00..0x03    magic "WBK1"   (4 bytes)
 *     0x04..0x07    version u32 LE
 *     0x08..0x0b    header length u32 LE (N)
 *     0x0c..0x0c+N  UTF-8 JSON header (BackupManifest)
 *     ...           ciphertext bytes (consumer-produced, we don't encrypt)
 *
 * The ciphertext itself is already AES-GCM-encrypted by KeyringService
 * before it reaches this adapter — we just wrap it in a self-describing
 * envelope that a future restore flow can validate.
 */

const MAGIC = new Uint8Array([0x57, 0x42, 0x4b, 0x31]) // "WBK1"
const VERSION = 1

const u32LE = (n: number): Uint8Array => {
  const out = new Uint8Array(4)
  out[0] = n & 0xff
  out[1] = (n >>> 8) & 0xff
  out[2] = (n >>> 16) & 0xff
  out[3] = (n >>> 24) & 0xff
  return out
}

const readU32LE = (bytes: Uint8Array, offset: number): number => {
  if (offset + 4 > bytes.length) throw new Error("short read")
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Pack an encrypted bundle + manifest into a single self-describing
 * file blob. Exposed for callers that want to format a bundle without
 * running the full adapter (e.g. direct file share from React Native).
 */
export const packBackupFile = (
  encryptedBundle: Uint8Array,
  manifest: BackupManifest,
): Uint8Array => {
  const header = textEncoder.encode(JSON.stringify(manifest))
  const totalLen = 4 + 4 + 4 + header.length + encryptedBundle.length
  const out = new Uint8Array(totalLen)
  let off = 0
  out.set(MAGIC, off)
  off += 4
  out.set(u32LE(VERSION), off)
  off += 4
  out.set(u32LE(header.length), off)
  off += 4
  out.set(header, off)
  off += header.length
  out.set(encryptedBundle, off)
  return out
}

export const unpackBackupFile = (
  file: Uint8Array,
): { bundle: Uint8Array; manifest: BackupManifest } => {
  if (file.length < 12) {
    throw new Error("backup file too short")
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (file[i] !== MAGIC[i]) {
      throw new Error("backup file magic mismatch")
    }
  }
  const version = readU32LE(file, 4)
  if (version !== VERSION) {
    throw new Error(`unsupported backup file version ${version}`)
  }
  const headerLen = readU32LE(file, 8)
  if (12 + headerLen > file.length) {
    throw new Error("backup file header length out of range")
  }
  const headerBytes = file.subarray(12, 12 + headerLen)
  const manifest = JSON.parse(textDecoder.decode(headerBytes)) as BackupManifest
  const bundle = file.subarray(12 + headerLen)
  return { bundle, manifest }
}

/**
 * Layer: FileExportBackupAdapter holds the last-exported file in memory.
 * Consuming apps typically build one of these, call exportBackup, and
 * hand the returned bytes off to a file-share dialog / OS API.
 */
export const FileExportBackupAdapter = Layer.effect(
  BackupAdapter,
  Effect.gen(function* () {
    const store = yield* Ref.make<{
      file: Uint8Array
      manifest: BackupManifest
      savedAt: number
    } | null>(null)

    return {
      exportBackup: (bundle, manifest) =>
        Effect.try({
          try: () => {
            // If the caller didn't provide a checksum, compute one over
            // just the encrypted bundle so it's deterministic and doesn't
            // include itself.
            const checksum = manifest.checksum || bytesToHex(sha256(bundle))
            const stamped: BackupManifest = { ...manifest, checksum }
            return { file: packBackupFile(bundle, stamped), manifest: stamped }
          },
          catch: (cause) =>
            new BackupError({ provider: "file-export", operation: "export", cause }),
        }).pipe(
          Effect.flatMap((result) =>
            Ref.set(store, { ...result, savedAt: Date.now() }),
          ),
        ),

      importBackup: () =>
        Effect.gen(function* () {
          const current = yield* Ref.get(store)
          if (!current) {
            return yield* Effect.fail(
              new BackupError({
                provider: "file-export",
                operation: "import",
                cause: "no backup file cached — call loadFile(bytes) first or exportBackup()",
              }),
            )
          }
          try {
            const { bundle, manifest } = unpackBackupFile(current.file)
            return { bundle, manifest }
          } catch (e) {
            return yield* Effect.fail(
              new BackupDecryptionError({
                message: `failed to unpack backup file: ${(e as Error).message}`,
              }),
            )
          }
        }),

      status: () =>
        Effect.map(Ref.get(store), (s) => ({
          exists: s !== null,
          ...(s ? { lastBackup: s.savedAt } : {}),
        })),
    }
  }),
)

/**
 * Thin helper for tests & callers that want to stuff a file they loaded
 * from disk / share sheet into the in-memory store. Returns a Layer that
 * pre-populates the adapter with a known file.
 */
export const FileExportBackupAdapterFromFile = (
  file: Uint8Array,
): Layer.Layer<BackupAdapter> =>
  Layer.effect(
    BackupAdapter,
    Effect.gen(function* () {
      const ref = yield* Ref.make<{
        file: Uint8Array
        manifest: BackupManifest
        savedAt: number
      } | null>(null)
      // Pre-unpack to validate magic + version + parse manifest.
      const { manifest } = unpackBackupFile(file)
      yield* Ref.set(ref, { file, manifest, savedAt: Date.now() })
      return {
        exportBackup: (bundle, manifest) =>
          Effect.try({
            try: () => packBackupFile(bundle, manifest),
            catch: (cause) =>
              new BackupError({
                provider: "file-export",
                operation: "export",
                cause,
              }),
          }).pipe(
            Effect.flatMap((newFile) =>
              Ref.set(ref, {
                file: newFile,
                manifest,
                savedAt: Date.now(),
              }),
            ),
          ),
        importBackup: () =>
          Effect.gen(function* () {
            const s = yield* Ref.get(ref)
            if (!s) {
              return yield* Effect.fail(
                new BackupError({
                  provider: "file-export",
                  operation: "import",
                  cause: "no backup cached",
                }),
              )
            }
            try {
              const { bundle, manifest } = unpackBackupFile(s.file)
              return { bundle, manifest }
            } catch (e) {
              return yield* Effect.fail(
                new BackupDecryptionError({
                  message: `failed to unpack: ${(e as Error).message}`,
                }),
              )
            }
          }),
        status: () =>
          Effect.map(Ref.get(ref), (s) => ({
            exists: s !== null,
            ...(s ? { lastBackup: s.savedAt } : {}),
          })),
      }
    }),
  )
