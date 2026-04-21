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

const deriveAptosAddress = (seed: Uint8Array): string => {
  const pubkey = ed25519.getPublicKey(seed)
  const buf = new Uint8Array(33)
  buf.set(pubkey, 0)
  buf[32] = 0x00
  return "0x" + bytesToHex(sha3_256(buf))
}

// Fake Aptos client tailored for the call-tx + simulate path. We echo
// the build params into a deterministic BCS-like blob and return a
// configurable simulate response.
const makeFakeAptos = (simulateResponse?: unknown) =>
  ({
    transaction: {
      build: {
        simple: async (params: {
          sender: { toString: () => string }
          data: {
            function: string
            functionArguments: unknown[]
            typeArguments?: unknown[]
          }
        }) => {
          const encoded = new TextEncoder().encode(
            JSON.stringify({
              sender: params.sender.toString(),
              function: params.data.function,
              args: params.data.functionArguments,
              typeArgs: params.data.typeArguments ?? [],
            }),
          )
          return {
            bcsToBytes: () => encoded,
            rawTransaction: { bcsToBytes: () => encoded },
          }
        },
      },
      simulate: {
        simple: async (_params: unknown) => [
          simulateResponse ?? {
            success: true,
            gas_used: "2000",
            vm_status: "Executed successfully",
          },
        ],
      },
    },
  }) as unknown as Aptos

describe("AptosChainAdapter.buildCallTx", () => {
  it("builds an arbitrary entry-function call with type + function args", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos(),
    })
    const from = deriveAptosAddress(new Uint8Array(32).fill(0x12))

    const tx = await Effect.runPromise(
      adapter.buildCallTx({
        kind: "aptos",
        chain: "aptos",
        from,
        function: "0x1::coin::transfer",
        typeArguments: ["0x1::aptos_coin::AptosCoin"],
        functionArguments: [from, "1000"],
        label: "custom transfer",
      }),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("entry-function")
    expect(tx.metadata.intent).toBe("custom transfer")

    const decoded = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(
          payload.rawTxHex
            .match(/.{2}/g)!
            .map((h: string) => parseInt(h, 16)),
        ),
      ),
    )
    expect(decoded.function).toBe("0x1::coin::transfer")
    expect(decoded.typeArgs).toEqual(["0x1::aptos_coin::AptosCoin"])
    expect(decoded.args).toEqual([from, "1000"])
  })

  it("rejects an EVM CallRequest with UnsupportedChainError", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos(),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = await Effect.runPromise(
      Effect.flip(
        adapter.buildCallTx({
          kind: "evm",
          chain: "evm:1",
          from: "0x0",
          to: "0x0",
        }),
      ),
    )
    expect(err._tag).toBe("UnsupportedChainError")
  })
})

describe("AptosChainAdapter.simulateCall", () => {
  it("maps success + gas_used from the SDK response", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos(),
    })
    const from = deriveAptosAddress(new Uint8Array(32).fill(0x13))

    const sim = await Effect.runPromise(
      adapter.simulateCall({
        kind: "aptos",
        chain: "aptos",
        from,
        function: "0x1::coin::transfer",
        typeArguments: ["0x1::aptos_coin::AptosCoin"],
        functionArguments: [from, "1000"],
      }),
    )
    expect(sim.success).toBe(true)
    expect(sim.gasUsed).toBe(2000n)
  })

  it("maps vm_status into revertReason on simulation failure", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos({
        success: false,
        gas_used: "500",
        vm_status: "Move abort: EINSUFFICIENT_BALANCE",
      }),
    })
    const from = deriveAptosAddress(new Uint8Array(32).fill(0x14))

    const sim = await Effect.runPromise(
      adapter.simulateCall({
        kind: "aptos",
        chain: "aptos",
        from,
        function: "0x1::coin::transfer",
        typeArguments: ["0x1::aptos_coin::AptosCoin"],
        functionArguments: [from, "1000"],
      }),
    )
    expect(sim.success).toBe(false)
    expect(sim.revertReason).toContain("EINSUFFICIENT_BALANCE")
    expect(sim.gasUsed).toBe(500n)
  })
})
