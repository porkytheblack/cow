import { Effect } from "effect"
import { FetchError } from "../../model/errors.js"
import type { FetchAdapterShape } from "../fetch/index.js"

/**
 * Generic JSON-RPC 2.0 client built on FetchAdapter. All chain adapters
 * that speak JSON-RPC (EVM, Solana) share this primitive — no direct
 * fetch, no SDK-bundled HTTP clients.
 */

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

interface JsonRpcResponse<T> {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly result?: T
  readonly error?: JsonRpcError
}

export const jsonRpcCall = <T>(
  fetcher: FetchAdapterShape,
  url: string,
  method: string,
  params: unknown = [],
): Effect.Effect<T, FetchError> =>
  Effect.gen(function* () {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    })
    const res = yield* fetcher.request({
      url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    })
    const json = yield* res.json<JsonRpcResponse<T>>()
    if (json.error) {
      return yield* Effect.fail(
        new FetchError({
          url,
          status: res.status,
          cause: `${method} failed: ${json.error.message} (${json.error.code})`,
        }),
      )
    }
    if (json.result === undefined) {
      return yield* Effect.fail(
        new FetchError({
          url,
          status: res.status,
          cause: `${method} returned no result`,
        }),
      )
    }
    return json.result
  })
