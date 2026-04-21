import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { ed25519 } from "@noble/curves/ed25519"
import { sha3_256 } from "@noble/hashes/sha3"
import { bytesToHex } from "@noble/hashes/utils"
import { makeAptosChainAdapter } from "../src/adapters/chain/aptos.js"
import type { ChainConfig } from "../src/model/chain.js"
import type { Aptos, PendingTransactionResponse } from "@aptos-labs/ts-sdk"
import type { SignedTx } from "../src/model/transaction.js"

const aptosChain: ChainConfig = {
  chainId: "aptos",
  name: "Aptos Test",
  rpcUrl: "https://rpc.test/aptos",
  kind: "aptos",
  cctpDomain: 9,
  nativeAsset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 },
}

// Fake Aptos that returns real-looking BCS bytes out of `build.simple`
// so `SimpleTransaction.deserialize` inside broadcast can succeed. We
// stub broadcast's success path but the framing parser runs for real.
const makeFakeAptos = (rawBcs: Uint8Array) => {
  let submitCalled = false
  const client = {
    transaction: {
      build: {
        simple: async () => ({
          bcsToBytes: () => rawBcs,
          rawTransaction: {
            bcsToBytes: () => rawBcs,
          },
        }),
      },
      submit: {
        simple: async () => {
          submitCalled = true
          return { hash: "0xfeed" } as PendingTransactionResponse
        },
      },
    },
    waitForTransaction: async () => ({}),
  } as unknown as Aptos
  return {
    client,
    wasSubmitCalled: () => submitCalled,
  }
}

const addressOf = (seedByte: number) => {
  const seed = new Uint8Array(32).fill(seedByte)
  const pubkey = ed25519.getPublicKey(seed)
  const buf = new Uint8Array(33)
  buf.set(pubkey, 0)
  buf[32] = 0x00
  return "0x" + bytesToHex(sha3_256(buf))
}

describe("AptosChainAdapter framing parser (sponsored tag)", () => {
  it("rejects framing with an unknown tag byte", async () => {
    const { client } = makeFakeAptos(new Uint8Array(0))
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    // Hand-build framing with tag=0x42. rawTxLen=0, pubkey=zeros, sig=zeros.
    const bogus = new Uint8Array(1 + 4 + 0 + 32 + 64)
    bogus[0] = 0x42
    const fake: SignedTx = {
      chain: "aptos",
      raw: bogus,
      hash: "0xabc",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsigned: {} as any,
    }
    const result = await Effect.runPromise(
      Effect.either(adapter.broadcast(fake)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
      expect(String(result.left.cause)).toContain("unknown Aptos framing tag")
    }
  })

  it("rejects truncated framing (rawTxLen overruns the buffer)", async () => {
    const { client } = makeFakeAptos(new Uint8Array(0))
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    // tag=0x00 (unsponsored) but claim rawTxLen=999 into a short buffer.
    const truncated = new Uint8Array(1 + 4 + 10 + 32 + 64)
    truncated[0] = 0x00
    truncated[1] = 0xff
    truncated[2] = 0x03
    truncated[3] = 0x00
    truncated[4] = 0x00
    const fake: SignedTx = {
      chain: "aptos",
      raw: truncated,
      hash: "0xabc",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsigned: {} as any,
    }
    const result = await Effect.runPromise(
      Effect.either(adapter.broadcast(fake)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
      expect(String(result.left.cause)).toContain("length mismatch")
    }
  })

  it("rejects empty framing", async () => {
    const { client } = makeFakeAptos(new Uint8Array(0))
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const fake: SignedTx = {
      chain: "aptos",
      raw: new Uint8Array(0),
      hash: "0x0",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsigned: {} as any,
    }
    const result = await Effect.runPromise(
      Effect.either(adapter.broadcast(fake)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
    }
  })

  it("rejects framing that is too short even for tag+header+sig+pubkey", async () => {
    const { client } = makeFakeAptos(new Uint8Array(0))
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const tooShort = new Uint8Array(10)
    tooShort[0] = 0x00
    const fake: SignedTx = {
      chain: "aptos",
      raw: tooShort,
      hash: "0x0",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsigned: {} as any,
    }
    const result = await Effect.runPromise(
      Effect.either(adapter.broadcast(fake)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
      expect(String(result.left.cause)).toContain("too short")
    }
  })

  it("attachSignature → broadcast round-trips a sponsored tag through the parser", async () => {
    // Minimum-viable SimpleTransaction BCS the SDK can round-trip
    // through SimpleTransaction.deserialize. We don't need the broadcast
    // to succeed — we just need the parser to reach submit.simple, which
    // proves the tag-aware decode works end to end.
    const { buildRealSimpleTx } = await import("./helpers/aptos-rawtx.js")
    const { simpleBcs: rawBcs } = buildRealSimpleTx(addressOf(0xa0), {
      sponsored: true,
    })

    let submitSaw: { transaction: unknown; senderAuthenticator: unknown } | null =
      null
    const client = {
      transaction: {
        build: {
          simple: async () => ({
            bcsToBytes: () => rawBcs,
            rawTransaction: {
              bcsToBytes: () => rawBcs,
            },
          }),
        },
        submit: {
          simple: async (args: {
            transaction: unknown
            senderAuthenticator: unknown
            feePayerAuthenticator?: unknown
          }) => {
            submitSaw = {
              transaction: args.transaction,
              senderAuthenticator: args.senderAuthenticator,
            }
            if ("feePayerAuthenticator" in args) {
              throw new Error(
                "feePayerAuthenticator must NOT be passed — plugin owns it",
              )
            }
            return { hash: "0x" + "ab".repeat(32) } as PendingTransactionResponse
          },
        },
      },
      waitForTransaction: async () => ({}),
    } as unknown as Aptos

    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      sponsored: true,
    })
    const seed = new Uint8Array(32).fill(0xa0)
    const pubkey = ed25519.getPublicKey(seed)
    const from = addressOf(0xa0)
    const tx = await Effect.runPromise(
      adapter.buildTransferTx({
        from,
        to: from,
        asset: aptosChain.nativeAsset,
        amount: 1n,
      }),
    )
    const sig = new Uint8Array(64).fill(0xaa)
    const signed = await Effect.runPromise(
      adapter.attachSignature(tx, sig, pubkey),
    )
    expect(signed.raw[0]).toBe(0x01)

    const receipt = await Effect.runPromise(adapter.broadcast(signed))
    expect(receipt.status).toBe("confirmed")
    expect(submitSaw).not.toBeNull()
    // Sender authenticator present; fee-payer one never passed.
    expect(submitSaw!.senderAuthenticator).toBeDefined()
  })
})
