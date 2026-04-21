import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import {
  AccountAddress,
  MoveVector,
  U32,
  U64,
} from "@aptos-labs/ts-sdk"
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
  sender: string
  bytecode?: Uint8Array
  functionName?: string
  functionArguments: unknown[]
  withFeePayer: boolean
}

const makeSpyAptos = () => {
  const calls: BuildCall[] = []
  const client = {
    transaction: {
      build: {
        simple: async (params: {
          sender: { toString: () => string }
          withFeePayer?: boolean
          data:
            | {
                bytecode: Uint8Array
                functionArguments: unknown[]
              }
            | {
                function: string
                functionArguments: unknown[]
              }
        }) => {
          const data = params.data as {
            bytecode?: Uint8Array
            function?: string
            functionArguments: unknown[]
          }
          calls.push({
            sender: params.sender.toString(),
            bytecode: data.bytecode,
            functionName: data.function,
            functionArguments: data.functionArguments,
            withFeePayer: params.withFeePayer ?? false,
          })
          const encoded = new TextEncoder().encode(
            JSON.stringify({
              kind: data.bytecode ? "script" : "entry",
              fn: data.function,
              hasBytecode: !!data.bytecode,
            }),
          )
          return {
            bcsToBytes: () => encoded,
            rawTransaction: { bcsToBytes: () => encoded },
          }
        },
      },
    },
  } as unknown as Aptos
  return { client, calls }
}

const addrFromSeed = (fill: number): string => {
  const seed = new Uint8Array(32).fill(fill)
  const pubkey = ed25519.getPublicKey(seed)
  const buf = new Uint8Array(33)
  buf.set(pubkey, 0)
  buf[32] = 0x00
  return "0x" + bytesToHex(sha3_256(buf))
}

describe("AptosChainAdapter CCTP V1", () => {
  it("buildCctpBurnTx fails with UnsupportedRouteError when no script bytecode is provided", async () => {
    const { client } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const from = addrFromSeed(0xaa)
    const exit = await Effect.runPromiseExit(
      adapter.buildCctpBurnTx({
        from,
        destinationDomain: 0,
        recipient: "0x" + "12".repeat(20),
        amount: 5_000_000n,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // Cause should carry UnsupportedRouteError tag.
    const cause = Exit.isFailure(exit) ? exit.cause : null
    expect(JSON.stringify(cause)).toContain("UnsupportedRouteError")
  })

  it("buildCctpBurnTx submits a script payload with typed args when bytecode is configured", async () => {
    const { client, calls } = makeSpyAptos()
    const burnScript = new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b, 0x01, 0x00])
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      cctpContracts: {
        depositForBurnScript: burnScript,
      },
    })
    const from = addrFromSeed(0xbb)
    const recipient = "0xABCDEF0123456789abcdef0123456789ABCDEF01" // 20 bytes
    const tx = await Effect.runPromise(
      adapter.buildCctpBurnTx({
        from,
        destinationDomain: 0,
        recipient,
        amount: 7_500_000n,
      }),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("cctp-burn")
    expect(payload.amount).toBe("7500000")
    expect(payload.recipient).toBe(recipient)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.bytecode).toBe(burnScript)
    expect(call.functionName).toBeUndefined()
    expect(call.functionArguments).toHaveLength(4)
    // Args: U64, U32, AccountAddress(mintRecipient), AccountAddress(usdcMetadata)
    expect(call.functionArguments[0]).toBeInstanceOf(U64)
    expect(call.functionArguments[1]).toBeInstanceOf(U32)
    expect(call.functionArguments[2]).toBeInstanceOf(AccountAddress)
    expect(call.functionArguments[3]).toBeInstanceOf(AccountAddress)
    // amount passed through as bigint.
    expect((call.functionArguments[0] as U64).value).toBe(7_500_000n)
    expect((call.functionArguments[1] as U32).value).toBe(0)
    // mintRecipient must be the 20-byte recipient left-padded to 32 bytes.
    const mintRecipientAddr = call.functionArguments[2] as AccountAddress
    expect(mintRecipientAddr.toString().toLowerCase()).toBe(
      "0x000000000000000000000000" + "abcdef0123456789abcdef0123456789abcdef01",
    )
  })

  it("buildMintTx fails when handleReceiveMessage bytecode is missing", async () => {
    const { client } = makeSpyAptos()
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
    })
    const recipient = addrFromSeed(0xcc)
    const exit = await Effect.runPromiseExit(
      adapter.buildMintTx({
        recipient,
        messageBytes: new Uint8Array([1, 2, 3]),
        attestation: "ab",
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? exit.cause : null
    expect(JSON.stringify(cause)).toContain("handleReceiveMessageScript")
  })

  it("buildMintTx submits a script payload with vector<u8> args when bytecode is configured", async () => {
    const { client, calls } = makeSpyAptos()
    const mintScript = new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b, 0x01, 0x00, 0x01])
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      cctpContracts: {
        handleReceiveMessageScript: mintScript,
      },
    })
    const recipient = addrFromSeed(0xdd)
    const messageBytes = new Uint8Array(248).fill(0x77)
    const attestation = "0x" + "aa".repeat(65)
    const tx = await Effect.runPromise(
      adapter.buildMintTx({
        recipient,
        messageBytes,
        attestation,
      }),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((tx.payload as any).kind).toBe("cctp-mint")
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.bytecode).toBe(mintScript)
    expect(call.functionArguments).toHaveLength(2)
    expect(call.functionArguments[0]).toBeInstanceOf(MoveVector)
    expect(call.functionArguments[1]).toBeInstanceOf(MoveVector)
  })

  it("buildCctpBurnTx honours cctpContracts.usdcTokenAddress override", async () => {
    const { client, calls } = makeSpyAptos()
    const customUsdc =
      "0x1234567890123456789012345678901234567890123456789012345678901234"
    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      cctpContracts: {
        depositForBurnScript: new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b]),
        usdcTokenAddress: customUsdc,
      },
    })
    const from = addrFromSeed(0xee)
    await Effect.runPromise(
      adapter.buildCctpBurnTx({
        from,
        destinationDomain: 5,
        recipient: "0x" + "11".repeat(32),
        amount: 1n,
      }),
    )
    const usdcArg = calls[0]!.functionArguments[3] as AccountAddress
    expect(usdcArg.toString().toLowerCase()).toBe(customUsdc.toLowerCase())
  })
})
