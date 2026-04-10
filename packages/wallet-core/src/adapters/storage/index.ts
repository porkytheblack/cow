import { Context, Effect } from "effect"
import { StorageError } from "../../model/errors.js"

export interface StorageAdapterShape {
  readonly save: (key: string, value: Uint8Array) => Effect.Effect<void, StorageError>
  readonly load: (key: string) => Effect.Effect<Uint8Array | null, StorageError>
  readonly delete: (key: string) => Effect.Effect<void, StorageError>
  readonly list: (prefix: string) => Effect.Effect<readonly string[], StorageError>
}

export class StorageAdapter extends Context.Tag("StorageAdapter")<
  StorageAdapter,
  StorageAdapterShape
>() {}
