import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { FetchAdapter } from "../src/adapters/fetch/index.js"
import { makeEvmChainAdapter, buildEvmCctpBurnTx } from "../src/adapters/chain/evm.js"
import type { ChainConfig } from "../src/model/chain.js"
import type { AssetId } from "../src/model/asset.js"

const evmChain: ChainConfig = {
  chainId: "evm:1",
  name: "Test EVM",
  rpcUrl: "https://rpc.test/evm",
  kind: "evm",
  cctpDomain: 0,
  nativeAsset: { chain: "evm:1", type: "native", symbol: "ETH", decimals: 18 },
}

const USDC: AssetId = {
  chain: "evm:1",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
}

// Record captured JSON-RPC calls so we can assert on them.
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
          if (result === undefined) {
            return {
              status: 200,
              body: {
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32601, message: `no mock for ${body.method}` },
              },
            }
          }
          return {
            status: 200,
            body: { jsonrpc: "2.0", id: 1, result },
          }
        },
      ],
    ],
    fallbackTo404: true,
  })

describe("EvmChainAdapter", () => {
  it("derives an EVM address from an uncompressed public key", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc({}, captured)
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      // Uncompressed pubkey (64 bytes, no 0x04 prefix).
      const pubkey = new Uint8Array(64).fill(0x01)
      return yield* adapter.deriveAddress(pubkey)
    })
    const addr = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it("builds a native ETH transfer and queries gas + nonce via JSON-RPC", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(
      {
        eth_estimateGas: "0x5208",
        eth_gasPrice: "0x3b9aca00", // 1 gwei
        eth_getTransactionCount: "0x5",
      },
      captured,
    )
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.buildTransferTx({
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        asset: evmChain.nativeAsset,
        amount: 1_000_000_000_000_000_000n, // 1 ETH
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(tx.chain).toBe("evm:1")
    expect(tx.estimatedFee).toBe(21_000n * 1_000_000_000n)
    const methodsCalled = captured.map((c) => c.method).sort()
    expect(methodsCalled).toEqual(
      ["eth_estimateGas", "eth_gasPrice", "eth_getTransactionCount"].sort(),
    )
  })

  it("builds an ERC20 transfer with encoded calldata", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(
      {
        eth_estimateGas: "0xea60",
        eth_gasPrice: "0x3b9aca00",
        eth_getTransactionCount: "0x0",
      },
      captured,
    )
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.buildTransferTx({
        from: "0x1111111111111111111111111111111111111111",
        to: "0x3333333333333333333333333333333333333333",
        asset: USDC,
        amount: 10_000_000n,
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, fetchLayer))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.to.toLowerCase()).toBe(USDC.address!.toLowerCase())
    expect(payload.value).toBe(0n)
    // transfer(address,uint256) selector is 0xa9059cbb
    expect(payload.data.startsWith("0xa9059cbb")).toBe(true)
  })

  it("signs a native transfer with a real secp256k1 private key", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(
      {
        eth_estimateGas: "0x5208",
        eth_gasPrice: "0x3b9aca00",
        eth_getTransactionCount: "0x0",
      },
      captured,
    )
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      const unsigned = yield* adapter.buildTransferTx({
        from: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
        to: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF",
        asset: evmChain.nativeAsset,
        amount: 1_000_000_000_000n,
      })
      // Standard dev private key (matches the address above)
      const pk = new Uint8Array(32).fill(0)
      pk[31] = 1
      return yield* adapter.sign(unsigned, pk)
    })
    const signed = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(signed.raw.length).toBeGreaterThan(0)
    expect(signed.hash.startsWith("0x")).toBe(true)
    expect(signed.hash.length).toBe(66)
  })

  it("encodes a CCTP V2 depositForBurn payload", () => {
    const tx = buildEvmCctpBurnTx(
      evmChain,
      {
        tokenMessenger: "0x1234567890123456789012345678901234567890",
        messageTransmitter: "0x0987654321098765432109876543210987654321",
        usdcToken: USDC.address as `0x${string}`,
      },
      {
        from: "0x1111111111111111111111111111111111111111",
        recipient: "0x2222222222222222222222222222222222222222",
        amount: 10_000_000n,
        destinationDomain: 5,
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("cctp-burn")
    expect(payload.to.toLowerCase()).toBe(
      "0x1234567890123456789012345678901234567890",
    )
    // depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)
    // Selector for V2 signature. Don't hardcode — just check it's a
    // valid 4-byte selector prefix followed by 7 32-byte params = 228 bytes.
    expect(payload.data.length).toBe(2 + 8 + 7 * 64)
  })
})
