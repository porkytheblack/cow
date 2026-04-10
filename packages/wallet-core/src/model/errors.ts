import { Data } from "effect"

export class KeyGenerationError extends Data.TaggedError("KeyGenerationError")<{
  readonly message: string
}> {}

export class KeyNotFoundError extends Data.TaggedError("KeyNotFoundError")<{
  readonly chain: string
  readonly address?: string
}> {}

export class AuthDeniedError extends Data.TaggedError("AuthDeniedError")<{
  readonly reason: string
}> {}

export class AuthTimeoutError extends Data.TaggedError("AuthTimeoutError")<{
  readonly reason?: string
}> {}

export class InsufficientBalanceError extends Data.TaggedError("InsufficientBalanceError")<{
  readonly chain: string
  readonly required: bigint
  readonly available: bigint
}> {}

export class BroadcastError extends Data.TaggedError("BroadcastError")<{
  readonly chain: string
  readonly hash?: string
  readonly cause: unknown
}> {}

export class FeeEstimationError extends Data.TaggedError("FeeEstimationError")<{
  readonly chain: string
  readonly cause: unknown
}> {}

export class CctpAttestationTimeout extends Data.TaggedError("CctpAttestationTimeout")<{
  readonly burnTxHash: string
  readonly elapsedMs: number
}> {}

export class CctpMintError extends Data.TaggedError("CctpMintError")<{
  readonly destChain: string
  readonly cause: unknown
}> {}

export class UnsupportedChainError extends Data.TaggedError("UnsupportedChainError")<{
  readonly chain: string
}> {}

export class UnsupportedRouteError extends Data.TaggedError("UnsupportedRouteError")<{
  readonly from: string
  readonly to: string
  readonly asset: string
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "read" | "write" | "delete" | "list"
  readonly key: string
  readonly cause: unknown
}> {}

export class BackupError extends Data.TaggedError("BackupError")<{
  readonly provider: string
  readonly operation: "export" | "import" | "status"
  readonly cause: unknown
}> {}

export class BackupDecryptionError extends Data.TaggedError("BackupDecryptionError")<{
  readonly message: string
}> {}

export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string
  readonly status?: number
  readonly cause: unknown
}> {}
