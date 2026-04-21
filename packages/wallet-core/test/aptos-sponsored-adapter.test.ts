import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { ed25519 } from "@noble/curves/ed25519"
import { sha3_256 } from "@noble/hashes/sha3"
import { bytesToHex } from "@noble/hashes/utils"
import { makeAptosChainAdapter } from "../src/adapters/chain/aptos.js"
import type { ChainConfig } from "../src/model/chain.js"
import type { Aptos } from "@aptos-labs/ts-sdk"

const aptosChain: ChainConfig = {
  chainId: "aptos",
  name: "Aptos Test",
  rpcUrl: "https://rpc.test/aptos",
  kind: "aptos",
  cctpDomain: 9,
  nativeAsset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 },
}

interface BuildCall {
  sender: unknown
  withFeePayer: unknown
  data: unknown
}

const makeSpyAptos = () => {
  const buildCalls: BuildCall[] = []
  const client = {
    transaction: {
      build: {
        simple: async (params: {
          sender: { toString: () => string }
          withFeePayer?: boolean
          data: {
            function: string
            functionArguments: unknown[]
            typeArguments?: unknown[]
          }
        }) => {
          buildCalls.push({
            sender: params.sender,
            withFeePayer: params.withFeePayer,
            data: params.data,
          })
          const encoded = new TextEncoder().encode(
            JSON.stringify({
              sender: params.sender.toString(),
              function: params.data.function,
              args: params.data.functionArguments,
              withFeePayer: params.withFeePayer ?? false,
            }),
          )
          return {
            bcsToBytes: () => encoded,
            rawTransaction: { bcsToBytes: () => encoded },
          }
        },
      },
    },
    getAccountCoinAmount: async () => "0",
  } as unknown as Aptos
  return { client, buildCalls }
}

const addressOf = (seedByte: number) => {
  const seed = new Uint8Array(32).fill(seedByte)
  const pubkey = ed25519.getPublicKey(seed)
  const buf = new Uint8Array(33)
  buf.set(pubkey, 0)
  buf[32] = 0x00
  return "0x" + bytesToHex(sha3_256(buf))
}

describe("AptosChainAdapter (sponsored mode)", () => {
  it("passes withFeePayer:true to build.simple when sponsored:true", async () => {
    const { client, buildCalls } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      sponsored: true,
    })
    const from = addressOf(0x22)
    await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    expect(buildCalls).toHaveLength(1)
    expect(buildCalls[0]!.withFeePayer).toBe(true)
  })

  it("passes withFeePayer:false to build.simple by default", async () => {
    const { client, buildCalls } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const from = addressOf(0x33)
    await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    expect(buildCalls).toHaveLength(1)
    expect(buildCalls[0]!.withFeePayer).toBe(false)
  })

  it("emits estimatedFee=0n on sponsored transfers so signer doesn't escalate auth", async () => {
    const { client } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      sponsored: true,
    })
    const from = addressOf(0x44)
    const tx = await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    expect(tx.estimatedFee).toBe(0n)
    const fee = await Effect.runPromise(adapter.estimateFee(tx))
    expect(fee).toBe(0n)
  })

  it("keeps estimatedFee>0 on unsponsored transfers (regression guard)", async () => {
    const { client } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const from = addressOf(0x55)
    const tx = await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    expect(tx.estimatedFee).toBe(2_000n)
  })

  it("tags framing byte 0x01 for sponsored signatures", async () => {
    const { client } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      sponsored: true,
    })
    const seed = new Uint8Array(32).fill(0x66)
    const pubkey = ed25519.getPublicKey(seed)
    const from = addressOf(0x66)
    const tx = await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    const sig = new Uint8Array(64).fill(0xaa)
    const signed = await Effect.runPromise(
      adapter.attachSignature(tx, sig, pubkey),
    )
    expect(signed.raw[0]).toBe(0x01)
  })

  it("tags framing byte 0x00 for unsponsored signatures (regression guard)", async () => {
    const { client } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const seed = new Uint8Array(32).fill(0x77)
    const pubkey = ed25519.getPublicKey(seed)
    const from = addressOf(0x77)
    const tx = await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    const sig = new Uint8Array(64).fill(0xbb)
    const signed = await Effect.runPromise(
      adapter.attachSignature(tx, sig, pubkey),
    )
    expect(signed.raw[0]).toBe(0x00)
  })

  it("passes withFeePayer:true on fungible-asset transfers when sponsored", async () => {
    const { client, buildCalls } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      sponsored: true,
    })
    const from = addressOf(0x88)
    await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: {
          chain: "aptos",
          type: "token",
          symbol: "USDC",
          decimals: 6,
          address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
        amount: 1_000_000n,
      }),
    )
    expect(buildCalls).toHaveLength(1)
    expect(buildCalls[0]!.withFeePayer).toBe(true)
    expect((buildCalls[0]!.data as { function: string }).function).toBe(
      "0x1::primary_fungible_store::transfer",
    )
  })
})
