import { Effect, Layer } from "effect"
import { FetchError } from "../../model/errors.js"
import { FetchAdapter, type FetchRequest, type FetchResponse } from "./index.js"

const decodeHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

const bodyToArray = async (res: Response): Promise<Uint8Array> => {
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

const textDecoder = new TextDecoder()

const makeResponse = (
  status: number,
  headers: Record<string, string>,
  body: Uint8Array,
  url: string,
): FetchResponse => ({
  status,
  headers,
  body,
  json: <T>() =>
    Effect.try({
      try: () => JSON.parse(textDecoder.decode(body)) as T,
      catch: (cause) => new FetchError({ url, status, cause }),
    }),
  text: () =>
    Effect.try({
      try: () => textDecoder.decode(body),
      catch: (cause) => new FetchError({ url, status, cause }),
    }),
})

/**
 * BrowserFetchAdapter — wraps `globalThis.fetch`. Works in browsers,
 * React Native, Node 18+, and Deno. No Node-specific APIs.
 */
export const BrowserFetchAdapter = Layer.succeed(FetchAdapter, {
  request: (req: FetchRequest) =>
    Effect.tryPromise({
      try: async () => {
        const controller =
          typeof AbortController !== "undefined" ? new AbortController() : undefined
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        if (req.timeoutMs && controller) {
          timeoutId = setTimeout(() => controller.abort(), req.timeoutMs)
        }
        try {
          const init: RequestInit = {
            method: req.method,
            headers: req.headers,
            body: req.body as BodyInit | undefined,
          }
          if (controller) {
            init.signal = controller.signal
          }
          const res = await fetch(req.url, init)
          const body = await bodyToArray(res)
          return makeResponse(res.status, decodeHeaders(res.headers), body, req.url)
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId)
        }
      },
      catch: (cause) => new FetchError({ url: req.url, cause }),
    }),
})
