import { Context, Effect } from "effect"
import type { ChainId } from "../../model/chain.js"
import { BackupError, BackupDecryptionError } from "../../model/errors.js"

export interface BackupManifest {
  readonly version: number
  readonly createdAt: number
  readonly chains: readonly ChainId[]
  readonly addressCount: number
  readonly checksum: string
}

export interface BackupAdapterShape {
  readonly exportBackup: (
    encryptedBundle: Uint8Array,
    manifest: BackupManifest,
  ) => Effect.Effect<void, BackupError>

  readonly importBackup: () => Effect.Effect<
    { bundle: Uint8Array; manifest: BackupManifest },
    BackupError | BackupDecryptionError
  >

  readonly status: () => Effect.Effect<
    { exists: boolean; lastBackup?: number },
    BackupError
  >
}

export class BackupAdapter extends Context.Tag("BackupAdapter")<
  BackupAdapter,
  BackupAdapterShape
>() {}
