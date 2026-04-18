import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { MoveVector } from "@aptos-labs/ts-sdk"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex } from "@noble/hashes/utils"
import type { Aptos } from "@aptos-labs/ts-sdk"
import { makeAptosChainAdapter } from "../src/adapters/chain/aptos.js"
import {
  APTOS_CCTP_V1_MAINNET,
  APTOS_CCTP_V1_TESTNET,
  APTOS_USDC_METADATA_MAINNET,
  APTOS_USDC_METADATA_TESTNET,
} from "../src/adapters/chain/aptos-cctp-scripts.js"
import type { ChainConfig } from "../src/model/chain.js"
import type { TxReceipt } from "../src/model/transaction.js"

const aptosChain: ChainConfig = {
  chainId: "aptos",
  name: "Aptos Test",
  rpcUrl: "https://rpc.test/aptos",
  kind: "aptos",
  cctpDomain: 9,
  nativeAsset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 },
}

const MOVE_MAGIC = [0xa1, 0x1c, 0xeb, 0x0b]

// Build a 248-byte CCTP V1 message with header + burn body. Only the
// fields that extractBurnMessage reads (sourceDomain, destDomain, nonce)
// are meaningful here; everything else is arbitrary filler.
const makeFixtureMessage = (
  sourceDomain: number,
  destDomain: number,
  nonce: bigint,
): Uint8Array => {
  const bytes = new Uint8Array(248)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0, false) // version
  view.setUint32(4, sourceDomain, false)
  view.setUint32(8, destDomain, false)
  view.setBigUint64(12, nonce, false)
  // Fill remaining bytes with a distinctive pattern so hash mismatches
  // are obvious when test fixtures drift.
  for (let i = 20; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff
  return bytes
}

describe("Aptos CCTP V1 bundled Move scripts", () => {
  it("APTOS_CCTP_V1_MAINNET ships all three scripts with Move bytecode magic", () => {
    const b = APTOS_CCTP_V1_MAINNET
    expect(b.version).toBe("v1")
    expect(b.usdcTokenAddress).toBe(APTOS_USDC_METADATA_MAINNET)
    for (const field of [
      b.depositForBurnScript,
      b.depositForBurnWithCallerScript,
      b.handleReceiveMessageScript,
    ]) {
      expect(field).toBeInstanceOf(Uint8Array)
      expect(field!.length).toBeGreaterThan(100) // non-trivial bytecode
      expect(Array.from(field!.slice(0, 4))).toEqual(MOVE_MAGIC)
    }
  })

  it("APTOS_CCTP_V1_TESTNET ships separate bytecode with testnet USDC address", () => {
    const b = APTOS_CCTP_V1_TESTNET
    expect(b.usdcTokenAddress).toBe(APTOS_USDC_METADATA_TESTNET)
    expect(APTOS_USDC_METADATA_TESTNET).not.toEqual(APTOS_USDC_METADATA_MAINNET)
    expect(b.handleReceiveMessageScript).not.toBe(
      APTOS_CCTP_V1_MAINNET.handleReceiveMessageScript,
    )
    // Testnet and mainnet scripts embed different package addresses, so
    // the raw bytes must differ even for same-sized scripts.
    expect(Array.from(b.handleReceiveMessageScript!)).not.toEqual(
      Array.from(APTOS_CCTP_V1_MAINNET.handleReceiveMessageScript!),
    )
  })
})

describe("Aptos CCTP V1 buildMintTx with bundled bytecode", () => {
  it("accepts the bundled mainnet bytecode end-to-end", async () => {
    let capturedArgs: unknown[] | undefined
    let capturedBytecode: Uint8Array | undefined
    const client = {
      transaction: {
        build: {
          simple: async (params: {
            data: { bytecode: Uint8Array; functionArguments: unknown[] }
          }) => {
            capturedArgs = params.data.functionArguments
            capturedBytecode = params.data.bytecode
            return {
              rawTransaction: {
                bcsToBytes: () => new Uint8Array([0x01, 0x02, 0x03]),
              },
            }
          },
        },
      },
    } as unknown as Aptos

    const adapter = makeAptosChainAdapter({
      chainConfig: aptosChain,
      aptosClient: client,
      cctpContracts: APTOS_CCTP_V1_MAINNET,
    })

    const tx = await Effect.runPromise(
      adapter.buildMintTx({
        recipient:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        messageBytes: new Uint8Array(248).fill(0x42),
        attestation: "0x" + "cd".repeat(65),
      }),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((tx.payload as any).kind).toBe("cctp-mint")
    expect(capturedBytecode).toBe(APTOS_CCTP_V1_MAINNET.handleReceiveMessageScript)
    expect(capturedArgs).toHaveLength(2)
    expect(capturedArgs![0]).toBeInstanceOf(MoveVector)
    expect(capturedArgs![1]).toBeInstanceOf(MoveVector)
  })
})

describe("Aptos extractBurnMessage", () => {
  const adapter = makeAptosChainAdapter({
    chainConfig: aptosChain,
    aptosClient: {} as Aptos,
    cctpContracts: APTOS_CCTP_V1_MAINNET,
  })

  it("parses a MessageSent event from receipt.raw.events", async () => {
    const msg = makeFixtureMessage(0 /* Ethereum */, 9 /* Aptos */, 1234n)
    const expectedHash = bytesToHex(keccak_256(msg))
    const receipt: TxReceipt = {
      chain: "aptos",
      hash: "0xdeadbeef",
      status: "confirmed",
      raw: {
        events: [
          { type: "0x1::coin::Deposit", data: { amount: "100" } },
          {
            type: "0x9bce...::message_transmitter::MessageSent",
            data: { message: "0x" + bytesToHex(msg) },
          },
        ],
      },
    }

    const burn = await Effect.runPromise(adapter.extractBurnMessage(receipt))
    expect(burn.sourceDomain).toBe(0)
    expect(burn.destDomain).toBe(9)
    expect(burn.nonce).toBe(1234n)
    expect(burn.burnTxHash).toBe("0xdeadbeef")
    expect(burn.messageHash).toBe(expectedHash)
    expect(Array.from(burn.messageBytes)).toEqual(Array.from(msg))
  })

  it("falls back to receipt.raw.cctpBurn when no events match", async () => {
    const receipt: TxReceipt = {
      chain: "aptos",
      hash: "0xabc",
      status: "confirmed",
      raw: {
        cctpBurn: {
          sourceDomain: 9,
          destDomain: 0,
          nonce: "77",
          messageHex: "deadbeef",
          messageHash: "cafebabe",
        },
      },
    }
    const burn = await Effect.runPromise(adapter.extractBurnMessage(receipt))
    expect(burn.nonce).toBe(77n)
    expect(burn.messageHash).toBe("cafebabe")
  })

  it("fails when the receipt has neither events nor cctpBurn override", async () => {
    const receipt: TxReceipt = {
      chain: "aptos",
      hash: "0x000",
      status: "confirmed",
      raw: null,
    }
    const exit = await Effect.runPromiseExit(adapter.extractBurnMessage(receipt))
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""
    expect(cause).toContain("no MessageSent event")
  })
})
