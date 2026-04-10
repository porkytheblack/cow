import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  FileExportBackupAdapter,
  FileExportBackupAdapterFromFile,
  packBackupFile,
  unpackBackupFile,
} from "../src/adapters/backup/file-export.js"
import { BackupAdapter } from "../src/adapters/backup/index.js"
import type { BackupManifest } from "../src/adapters/backup/index.js"

const sampleManifest = (overrides: Partial<BackupManifest> = {}): BackupManifest => ({
  version: 1,
  createdAt: 1_700_000_000_000,
  chains: ["aptos", "solana", "evm:1"],
  addressCount: 3,
  checksum: "",
  ...overrides,
})

describe("FileExportBackupAdapter", () => {
  it("pack + unpack round-trips bytes and the manifest", () => {
    const bundle = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const manifest = sampleManifest({ checksum: "abc" })
    const file = packBackupFile(bundle, manifest)
    const { bundle: decoded, manifest: decodedManifest } = unpackBackupFile(file)
    expect(Array.from(decoded)).toEqual(Array.from(bundle))
    expect(decodedManifest).toEqual(manifest)
  })

  it("exportBackup stores the file and importBackup returns the same bytes", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* BackupAdapter
      const bundle = new Uint8Array([9, 8, 7, 6, 5])
      yield* adapter.exportBackup(bundle, sampleManifest())
      const status = yield* adapter.status()
      expect(status.exists).toBe(true)
      const { bundle: restored, manifest } = yield* adapter.importBackup()
      return { restored, manifest }
    })
    const { restored, manifest } = await Effect.runPromise(
      Effect.provide(program, FileExportBackupAdapter),
    )
    expect(Array.from(restored)).toEqual([9, 8, 7, 6, 5])
    // Checksum is auto-stamped by the adapter.
    expect(manifest.checksum.length).toBeGreaterThan(0)
  })

  it("FileExportBackupAdapterFromFile can pre-load an existing backup", async () => {
    const bundle = new Uint8Array([42, 42, 42])
    const file = packBackupFile(bundle, sampleManifest({ checksum: "preset" }))
    const program = Effect.gen(function* () {
      const adapter = yield* BackupAdapter
      const { bundle: restored, manifest } = yield* adapter.importBackup()
      return { restored, manifest }
    })
    const { restored, manifest } = await Effect.runPromise(
      Effect.provide(program, FileExportBackupAdapterFromFile(file)),
    )
    expect(Array.from(restored)).toEqual([42, 42, 42])
    expect(manifest.checksum).toBe("preset")
  })

  it("rejects files with bad magic bytes", () => {
    const bogus = new Uint8Array(50)
    expect(() => unpackBackupFile(bogus)).toThrow(/magic mismatch/)
  })
})
