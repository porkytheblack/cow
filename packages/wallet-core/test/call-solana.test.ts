import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { PublicKey } from "@solana/web3.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { FetchAdapter } from "../src/adapters/fetch/index.js"
import { makeSolanaChainAdapter } from "../src/adapters/chain/solana.js"
import type { ChainConfig } from "../src/model/chain.js"

const solChain: ChainConfig = {
  chainId: "solana",
  name: "Solana Test",
  rpcUrl: "https://rpc.test/sol",
  kind: "solana",
  cctpDomain: 5,
  nativeAsset: { chain: "solana", type: "native", symbol: "SOL", decimals: 9 },
}

// The Solana Memo v2 program — used here purely as a well-known
// programId for the test. Its data payload is a raw UTF-8 string.
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

const mockRpc = (
  responses: Record<string, unknown>,
  captured: { method: string; params: unknown }[],
) =>
  makeMockFetchAdapter({
    handlers: [
      [
        "rpc.test",
        (req) => {
          const body = JSON.parse(
            typeof req.body === "string"
              ? req.body
              : new TextDecoder().decode(req.body as Uint8Array),
          ) as { method: string; params: unknown }
          captured.push({ method: body.method, params: body.params })
          const result = responses[body.method]
          return {
            status: 200,
            body:
              result !== undefined
                ? { jsonrpc: "2.0", id: 1, result }
                : {
                    jsonrpc: "2.0",
                    id: 1,
                    error: { code: -32601, message: "no mock" },
                  },
          }
        },
      ],
    ],
    fallbackTo404: true,
  })

describe("SolanaChainAdapter.buildCallTx", () => {
  it("builds a Memo program invocation with a fetched recent blockhash", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(
      {
        getLatestBlockhash: {
          context: { slot: 100 },
          value: {
            blockhash: "FwRYtTPRk5N4wUeP87rTw9kQVSwigB6kbikGzzeCMrW5",
            lastValidBlockHeight: 200,
          },
        },
      },
      captured,
    )

    const from = PublicKey.unique().toBase58()
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      return yield* adapter.buildCallTx({
        kind: "solana",
        chain: "solana",
        from,
        instructions: [
          {
            programId: MEMO_PROGRAM,
            keys: [{ pubkey: from, isSigner: true, isWritable: false }],
            data: new TextEncoder().encode("hello from cow"),
          },
        ],
        label: "memo hello",
      })
    })

    const tx = await Effect.runPromise(Effect.provide(program, fetchLayer))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("contract-call")
    expect(payload.instructions).toHaveLength(1)
    expect(payload.instructions[0].programId).toBe(MEMO_PROGRAM)
    expect(payload.blockhash).toBe("FwRYtTPRk5N4wUeP87rTw9kQVSwigB6kbikGzzeCMrW5")
    expect(payload.feePayer).toBe(from)
    expect(tx.metadata.intent).toBe("memo hello")
    expect(captured.some((c) => c.method === "getLatestBlockhash")).toBe(true)
  })

  it("rejects an EVM CallRequest with UnsupportedChainError", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc({}, captured)
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      return yield* adapter.buildCallTx({
        kind: "evm",
        chain: "evm:1",
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
      })
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = await Effect.runPromise(
      Effect.flip(Effect.provide(program, fetchLayer)),
    )
    expect(err._tag).toBe("UnsupportedChainError")
  })

  it("rejects an empty instruction array", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc({}, captured)
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      return yield* adapter.buildCallTx({
        kind: "solana",
        chain: "solana",
        from: PublicKey.unique().toBase58(),
        instructions: [],
      })
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = await Effect.runPromise(
      Effect.flip(Effect.provide(program, fetchLayer)),
    )
    expect(err._tag).toBe("FeeEstimationError")
  })
})

describe("SolanaChainAdapter.simulateCall", () => {
  it("maps a successful simulateTransaction response", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(
      {
        getLatestBlockhash: {
          context: { slot: 100 },
          value: {
            blockhash: "FwRYtTPRk5N4wUeP87rTw9kQVSwigB6kbikGzzeCMrW5",
            lastValidBlockHeight: 200,
          },
        },
        simulateTransaction: {
          context: { slot: 100 },
          value: {
            err: null,
            logs: ["Program log: hello"],
            unitsConsumed: 1234,
          },
        },
      },
      captured,
    )

    const from = PublicKey.unique().toBase58()
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      return yield* adapter.simulateCall({
        kind: "solana",
        chain: "solana",
        from,
        instructions: [
          {
            programId: MEMO_PROGRAM,
            keys: [{ pubkey: from, isSigner: true, isWritable: false }],
            data: new TextEncoder().encode("sim"),
          },
        ],
      })
    })

    const sim = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(sim.success).toBe(true)
    expect(sim.gasUsed).toBe(1234n)
    expect(sim.logs).toEqual(["Program log: hello"])
  })

  it("surfaces Solana program errors in revertReason", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(
      {
        getLatestBlockhash: {
          context: { slot: 100 },
          value: {
            blockhash: "FwRYtTPRk5N4wUeP87rTw9kQVSwigB6kbikGzzeCMrW5",
            lastValidBlockHeight: 200,
          },
        },
        simulateTransaction: {
          context: { slot: 100 },
          value: {
            err: { InstructionError: [0, { Custom: 6001 }] },
            logs: ["Program log: boom"],
          },
        },
      },
      captured,
    )

    const from = PublicKey.unique().toBase58()
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      return yield* adapter.simulateCall({
        kind: "solana",
        chain: "solana",
        from,
        instructions: [
          {
            programId: MEMO_PROGRAM,
            keys: [{ pubkey: from, isSigner: true, isWritable: false }],
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      })
    })

    const sim = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(sim.success).toBe(false)
    expect(sim.revertReason).toContain("Custom")
  })
})
