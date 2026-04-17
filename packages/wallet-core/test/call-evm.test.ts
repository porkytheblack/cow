import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { encodeFunctionData, type Hex } from "viem"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { FetchAdapter } from "../src/adapters/fetch/index.js"
import { makeEvmChainAdapter } from "../src/adapters/chain/evm.js"
import type { ChainConfig } from "../src/model/chain.js"

const evmChain: ChainConfig = {
  chainId: "evm:1",
  name: "Test EVM",
  rpcUrl: "https://rpc.test/evm",
  kind: "evm",
  cctpDomain: 0,
  nativeAsset: { chain: "evm:1", type: "native", symbol: "ETH", decimals: 18 },
}

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const SPENDER = "0x1111111111111111111111111111111111111111"
const FROM = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"

const mockRpc = (
  handlers: (
    body: { method: string; params: unknown },
  ) => { result?: unknown; error?: { code: number; message: string; data?: string } },
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
          const res = handlers(body)
          return {
            status: 200,
            body: { jsonrpc: "2.0", id: 1, ...res },
          }
        },
      ],
    ],
    fallbackTo404: true,
  })

describe("EvmChainAdapter.buildCallTx", () => {
  it("encodes an ERC20 approve calldata and fills fees from RPC", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc((b) => {
      const responses: Record<string, unknown> = {
        eth_estimateGas: "0xea60",
        eth_getTransactionCount: "0x7",
        eth_maxPriorityFeePerGas: "0x3b9aca00",
        eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
      }
      return { result: responses[b.method] }
    }, captured)

    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [SPENDER, 10_000_000n],
    })

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.buildCallTx({
        kind: "evm",
        chain: "evm:1",
        from: FROM,
        to: USDC_ADDRESS,
        data,
        value: 0n,
        label: "approve USDC",
      })
    })

    const tx = await Effect.runPromise(Effect.provide(program, fetchLayer))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("contract-call")
    expect(payload.to.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase())
    expect(payload.value).toBe(0n)
    // approve(address,uint256) selector is 0x095ea7b3
    expect(payload.data.startsWith("0x095ea7b3")).toBe(true)
    expect(payload.gas).toBe(0xea60n)
    expect(payload.nonce).toBe(7)
    expect(payload.maxFeePerGas).toBeDefined()
    expect(tx.metadata.intent).toBe("approve USDC")
    expect(tx.estimatedFee).toBeGreaterThan(0n)
  })

  it("honours caller-supplied gas/fee/nonce overrides without re-querying when complete", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc((_b) => ({ result: undefined }), captured)

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.buildCallTx({
        kind: "evm",
        chain: "evm:1",
        from: FROM,
        to: USDC_ADDRESS,
        data: "0x" as Hex,
        gas: 21_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        nonce: 42,
      })
    })

    const tx = await Effect.runPromise(Effect.provide(program, fetchLayer))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.gas).toBe(21_000n)
    expect(payload.maxFeePerGas).toBe(2_000_000_000n)
    expect(payload.nonce).toBe(42)
    // No RPC should have been called because every field was provided.
    expect(captured).toHaveLength(0)
    expect(tx.estimatedFee).toBe(21_000n * 2_000_000_000n)
  })

  it("rejects a non-evm CallRequest with UnsupportedChainError", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc(() => ({ result: undefined }), captured)
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.buildCallTx({
        kind: "solana",
        chain: "solana",
        from: "11111111111111111111111111111111",
        instructions: [],
      })
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = await Effect.runPromise(
      Effect.flip(Effect.provide(program, fetchLayer)),
    )
    expect(err._tag).toBe("UnsupportedChainError")
  })
})

describe("EvmChainAdapter.simulateCall", () => {
  it("returns success + returnData on a clean eth_call", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc((b) => {
      if (b.method === "eth_call") {
        // `balanceOf` return: 32-byte uint256 = 42
        return {
          result:
            "0x000000000000000000000000000000000000000000000000000000000000002a",
        }
      }
      return { result: undefined }
    }, captured)

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.simulateCall({
        kind: "evm",
        chain: "evm:1",
        from: FROM,
        to: USDC_ADDRESS,
        data: "0x70a08231000000000000000000000000000000000000000000000000000000000000dead" as Hex,
      })
    })

    const sim = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(sim.success).toBe(true)
    expect(sim.returnData).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000002a",
    )
    expect(captured.map((c) => c.method)).toContain("eth_call")
  })

  it("decodes an Error(string) revert into revertReason", async () => {
    const captured: { method: string; params: unknown }[] = []
    // "insufficient allowance" encoded as Error(string):
    //   selector 0x08c379a0 + offset 0x20 + len 0x15 + "insufficient allowance" + padding
    const revertData =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000015" +
      // "insufficient allowance" = 22 bytes... wait len was 0x15 = 21. Use "not enough funds" = 16 bytes.
      ""
    const msg = "not enough funds"
    const msgHex = Buffer.from(msg, "utf8").toString("hex")
    const lenHex = msg.length.toString(16).padStart(64, "0")
    const paddedMsg = msgHex.padEnd(64, "0")
    const fullRevertData =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      lenHex +
      paddedMsg

    const fetchLayer = mockRpc((b) => {
      if (b.method === "eth_call") {
        return {
          error: {
            code: 3,
            message: "execution reverted",
            data: fullRevertData,
          },
        }
      }
      return { result: undefined }
    }, captured)

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.simulateCall({
        kind: "evm",
        chain: "evm:1",
        from: FROM,
        to: USDC_ADDRESS,
        data: "0x" as Hex,
      })
    })

    const sim = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(sim.success).toBe(false)
    expect(sim.revertReason).toBe(msg)
  })

  it("falls back to error.message when no revert data is present", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc((b) => {
      if (b.method === "eth_call") {
        return {
          error: {
            code: -32000,
            message: "gas required exceeds allowance",
          },
        }
      }
      return { result: undefined }
    }, captured)

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      return yield* adapter.simulateCall({
        kind: "evm",
        chain: "evm:1",
        from: FROM,
        to: USDC_ADDRESS,
        data: "0x" as Hex,
      })
    })

    const sim = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(sim.success).toBe(false)
    expect(sim.revertReason).toBe("gas required exceeds allowance")
  })
})

describe("EvmChainAdapter call round-trip", () => {
  it("built call → sign → attachSignature yields a broadcastable blob", async () => {
    const captured: { method: string; params: unknown }[] = []
    const fetchLayer = mockRpc((b) => {
      const responses: Record<string, unknown> = {
        eth_estimateGas: "0xea60",
        eth_getTransactionCount: "0x0",
        eth_maxPriorityFeePerGas: "0x3b9aca00",
        eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
      }
      return { result: responses[b.method] }
    }, captured)

    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [SPENDER, 1n],
    })

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeEvmChainAdapter({ chainConfig: evmChain, fetcher })
      const unsigned = yield* adapter.buildCallTx({
        kind: "evm",
        chain: "evm:1",
        from: FROM,
        to: USDC_ADDRESS,
        data,
      })
      const pk = new Uint8Array(32).fill(0)
      pk[31] = 1
      return yield* adapter.sign(unsigned, pk)
    })

    const signed = await Effect.runPromise(Effect.provide(program, fetchLayer))
    expect(signed.raw.length).toBeGreaterThan(0)
    expect(signed.hash.startsWith("0x")).toBe(true)
    expect(signed.hash.length).toBe(66)
  })
})
