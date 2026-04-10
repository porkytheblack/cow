import { Context, Effect } from "effect"
import { FetchError } from "../../model/errors.js"

export interface FetchRequest {
  readonly url: string
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array
  readonly timeoutMs?: number
}

export interface FetchResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Uint8Array
  readonly json: <T = unknown>() => Effect.Effect<T, FetchError>
  readonly text: () => Effect.Effect<string, FetchError>
}

export interface FetchAdapterShape {
  readonly request: (req: FetchRequest) => Effect.Effect<FetchResponse, FetchError>
}

export class FetchAdapter extends Context.Tag("FetchAdapter")<
  FetchAdapter,
  FetchAdapterShape
>() {}

export { FetchError }
