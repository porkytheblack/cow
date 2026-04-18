import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { FetchAdapter } from "../src/adapters/fetch/index.js"
import { pollCircleAttestation } from "../src/services/cctp.js"
import type { BurnMessage } from "../src/model/cctp.js"

const makeBurn = (messageHash = "cafebabe"): BurnMessage => ({
  sourceDomain: 0,
  destDomain: 9,
  nonce: 1n,
  burnTxHash: "0xtest",
  messageBytes: new Uint8Array([0xde, 0xad]),
  messageHash,
})

interface RequestRecord {
  url: string
}

const makeRecordingFetch = () => {
  const requests: RequestRecord[] = []
  const layer = Layer.succeed(FetchAdapter, {
    request: ({ url }: { url: string }) => {
      requests.push({ url })
      return Effect.succeed({
        status: 200,
        headers: {},
        body: new Uint8Array(),
        json: <T>() =>
          Effect.succeed({
            messages: [
              {
                status: "complete",
                attestation: "0xabc",
                message: "0x",
              },
            ],
          } as T),
        text: () => Effect.succeed(""),
      })
    },
  })
  return { layer, requests }
}

describe("pollCircleAttestation URL construction", () => {
  it("appends /v1/attestations/{hash} when version=v1 and URL is a root", async () => {
    const { layer, requests } = makeRecordingFetch()
    const program = Effect.gen(function* () {
      const f = yield* FetchAdapter
      return yield* pollCircleAttestation(f, "https://iris.circle.test", makeBurn("deadbeef"), {
        intervalMs: 1,
        timeoutMs: 1_000,
        version: "v1",
      })
    })
    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.attestation).toBe("abc")
    expect(requests[0]!.url).toBe(
      "https://iris.circle.test/v1/attestations/0xdeadbeef",
    )
  })

  it("appends /v2/attestations/{hash} when version=v2 and URL is a root", async () => {
    const { layer, requests } = makeRecordingFetch()
    const program = Effect.gen(function* () {
      const f = yield* FetchAdapter
      return yield* pollCircleAttestation(f, "https://iris.circle.test/", makeBurn(), {
        intervalMs: 1,
        timeoutMs: 1_000,
        version: "v2",
      })
    })
    await Effect.runPromise(Effect.provide(program, layer))
    expect(requests[0]!.url).toBe(
      "https://iris.circle.test/v2/attestations/0xcafebabe",
    )
  })

  it("preserves an explicit /v1 or /v2 segment already on the URL", async () => {
    const { layer, requests } = makeRecordingFetch()
    const program = Effect.gen(function* () {
      const f = yield* FetchAdapter
      yield* pollCircleAttestation(f, "https://iris.circle.test/v1", makeBurn(), {
        intervalMs: 1,
        timeoutMs: 1_000,
        // Caller pinned v1 — `version: "v2"` override must be ignored.
        version: "v2",
      })
    })
    await Effect.runPromise(Effect.provide(program, layer))
    expect(requests[0]!.url).toBe(
      "https://iris.circle.test/v1/attestations/0xcafebabe",
    )
  })

  it("defaults to v2 when no version is supplied", async () => {
    const { layer, requests } = makeRecordingFetch()
    const program = Effect.gen(function* () {
      const f = yield* FetchAdapter
      yield* pollCircleAttestation(f, "https://iris.circle.test", makeBurn(), {
        intervalMs: 1,
        timeoutMs: 1_000,
      })
    })
    await Effect.runPromise(Effect.provide(program, layer))
    expect(requests[0]!.url).toBe(
      "https://iris.circle.test/v2/attestations/0xcafebabe",
    )
  })
})
