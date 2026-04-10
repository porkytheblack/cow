import { Effect, Layer, Ref } from "effect"
import type { BackupManifest } from "./index.js"
import { BackupAdapter } from "./index.js"
import { BackupError } from "../../model/errors.js"

interface StoredBackup {
  readonly bundle: Uint8Array
  readonly manifest: BackupManifest
  readonly savedAt: number
}

/**
 * InMemoryBackupAdapter — test harness. Persists a single backup bundle
 * in-process. Calling `importBackup()` before `exportBackup()` fails with
 * a BackupError.
 */
export const InMemoryBackupAdapter = Layer.effect(
  BackupAdapter,
  Effect.gen(function* () {
    const store = yield* Ref.make<StoredBackup | null>(null)
    return {
      exportBackup: (bundle, manifest) =>
        Ref.set(store, { bundle, manifest, savedAt: Date.now() }),
      importBackup: () =>
        Effect.flatMap(Ref.get(store), (s) =>
          s
            ? Effect.succeed({ bundle: s.bundle, manifest: s.manifest })
            : Effect.fail(
                new BackupError({
                  provider: "memory",
                  operation: "import",
                  cause: "no backup stored",
                }),
              ),
        ),
      status: () =>
        Effect.map(Ref.get(store), (s) => ({
          exists: s !== null,
          ...(s ? { lastBackup: s.savedAt } : {}),
        })),
    }
  }),
)
