import { Effect, Layer } from "effect"
import { FetchError } from "../../model/errors.js"
import { FetchAdapter, type FetchRequest, type FetchResponse } from "./index.js"

export type MockHandler = (
  req: FetchRequest,
) => { status: number; body: unknown; headers?: Record<string, string> }

export interface MockFetchOptions {
  /** Map of URL substring -> handler. First match wins. */
  readonly handlers: ReadonlyArray<[pattern: string | RegExp, handler: MockHandler]>
  /** If no pattern matches, respond with 404 instead of failing. */
  readonly fallbackTo404?: boolean
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const toBodyBytes = (body: unknown): Uint8Array => {
  if (body instanceof Uint8Array) return body
  if (typeof body === "string") return textEncoder.encode(body)
  return textEncoder.encode(JSON.stringify(body))
}

const buildResponse = (
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string>,
  url: string,
): FetchResponse => ({
  status,
  headers,
  body: bytes,
  json: <T>() =>
    Effect.try({
      try: () => JSON.parse(textDecoder.decode(bytes)) as T,
      catch: (cause) => new FetchError({ url, status, cause }),
    }),
  text: () =>
    Effect.try({
      try: () => textDecoder.decode(bytes),
      catch: (cause) => new FetchError({ url, status, cause }),
    }),
})

const matches = (pattern: string | RegExp, url: string): boolean =>
  typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)

/**
 * MockFetchAdapter — deterministic fetch for tests. Matches request URLs
 * against string substrings or RegExps and returns canned responses.
 */
export const makeMockFetchAdapter = (options: MockFetchOptions) =>
  Layer.succeed(FetchAdapter, {
    request: (req: FetchRequest) => {
      const entry = options.handlers.find(([p]) => matches(p, req.url))
      if (!entry) {
        if (options.fallbackTo404) {
          return Effect.succeed(
            buildResponse(404, textEncoder.encode("not found"), {}, req.url),
          )
        }
        return Effect.fail(
          new FetchError({
            url: req.url,
            status: 404,
            cause: `No mock handler matched ${req.url}`,
          }),
        )
      }
      return Effect.sync(() => {
        const result = entry[1](req)
        return buildResponse(
          result.status,
          toBodyBytes(result.body),
          result.headers ?? { "content-type": "application/json" },
          req.url,
        )
      })
    },
  })
