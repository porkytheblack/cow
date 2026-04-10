import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { PublicKey } from "@solana/web3.js"
import { ed25519 } from "@noble/curves/ed25519"
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

describe("SolanaChainAdapter", () => {
  it("derives a base58 address from a 32-byte ed25519 public key", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc({}, captured)
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      const pk = new Uint8Array(32).fill(0x07)
      return yield* adapter.deriveAddress(pk)
    })
    const address = await Effect.runPromise(Effect.provide(program, fetchLayer))
    // Round-trip through PublicKey to validate base58 format.
    expect(new PublicKey(address).toBase58()).toBe(address)
  })

  it("builds a native SOL transfer with a fetched recent blockhash", async () => {
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
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      const from = PublicKey.unique().toBase58()
      const to = PublicKey.unique().toBase58()
      return yield* adapter.buildTransferTx({
        from,
        to,
        asset: solChain.nativeAsset,
        amount: 1_000_000_000n, // 1 SOL
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, fetchLayer))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("direct-transfer")
    expect(payload.instructions.length).toBe(1)
    expect(payload.blockhash).toBe("FwRYtTPRk5N4wUeP87rTw9kQVSwigB6kbikGzzeCMrW5")
    expect(captured.some((c) => c.method === "getLatestBlockhash")).toBe(true)
  })

  it("signs a built native transfer and returns a raw tx + signature hash", async () => {
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
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      // Derive a valid keypair deterministically
      const seed = new Uint8Array(32).fill(3)
      const pubkeyBytes = ed25519.getPublicKey(seed)
      const from = new PublicKey(pubkeyBytes).toBase58()
      const to = PublicKey.unique().toBase58()
      const unsigned = yield* adapter.buildTransferTx({
        from,
        to,
        asset: solChain.nativeAsset,
        amount: 1_000n,
      })
      return yield* adapter.sign(unsigned, seed)
    })
    const signed = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(signed.raw.length).toBeGreaterThan(0)
    expect(signed.hash.length).toBeGreaterThan(0)
  })
})
