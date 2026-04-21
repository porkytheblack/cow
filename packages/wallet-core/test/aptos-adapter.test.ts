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

// Tiny fake Aptos client — we only need `transaction.build.simple`
// and the coin-amount getters for the unit tests.
const makeFakeAptos = () =>
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
          // Return an object whose bcsToBytes() returns a deterministic
          // placeholder blob. Real Aptos client returns a
          // SimpleTransaction whose bcsToBytes() is the full
          // RawTransaction + feePayerAddress + secondarySigners BCS.
          const encoded = new TextEncoder().encode(
            JSON.stringify({
              sender: params.sender.toString(),
              function: params.data.function,
              args: params.data.functionArguments,
            }),
          )
          return {
            bcsToBytes: () => encoded,
            rawTransaction: { bcsToBytes: () => encoded },
          }
        },
      },
    },
    getAccountCoinAmount: async () => "123",
  }) as unknown as Aptos

describe("AptosChainAdapter", () => {
  it("derives an Aptos address from a 32-byte ed25519 public key", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos(),
    })
    const pk = new Uint8Array(32).fill(0x11)
    const addr = await Effect.runPromise(adapter.deriveAddress(pk))
    // Expected: 0x + hex(sha3_256(pk || 0x00))
    const buf = new Uint8Array(33)
    buf.set(pk, 0)
    buf[32] = 0x00
    expect(addr).toBe("0x" + bytesToHex(sha3_256(buf)))
  })

  it("builds a native APT transfer via aptos_account::transfer_coins", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos(),
    })
    // Derive a valid address from a seed so AccountAddress.fromString doesn't choke.
    const seed = new Uint8Array(32).fill(0x02)
    const pubkey = ed25519.getPublicKey(seed)
    const buf = new Uint8Array(33)
    buf.set(pubkey, 0)
    buf[32] = 0x00
    const from = "0x" + bytesToHex(sha3_256(buf))

    const tx = await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1_000n,
      }),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("direct-transfer")
    const decoded = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(
          payload.rawTxHex
            .match(/.{2}/g)!
            .map((h: string) => parseInt(h, 16)),
        ),
      ),
    )
    expect(decoded.function).toBe("0x1::aptos_account::transfer_coins")
  })

  it("fetches a native coin balance via the injected client", async () => {
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: makeFakeAptos(),
    })
    const seed = new Uint8Array(32).fill(0x04)
    const pubkey = ed25519.getPublicKey(seed)
    const buf = new Uint8Array(33)
    buf.set(pubkey, 0)
    buf[32] = 0x00
    const addr = "0x" + bytesToHex(sha3_256(buf))
    const balance = await Effect.runPromise(
      adapter.getBalance(addr, aptosChain.nativeAsset),
    )
    expect(balance).toBe(123n)
  })
})
