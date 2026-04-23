import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { PublicKey } from "@solana/web3.js"
import { ed25519 } from "@noble/curves/ed25519"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { FetchAdapter } from "../src/adapters/fetch/index.js"
import {
  DEFAULT_SOLANA_CCTP_V1,
  makeSolanaChainAdapter,
} from "../src/adapters/chain/solana.js"
import type { ChainConfig } from "../src/model/chain.js"

const solChain: ChainConfig = {
  chainId: "solana",
  name: "Solana Test",
  rpcUrl: "https://rpc.test/sol",
  kind: "solana",
  cctpDomain: 5,
  nativeAsset: { chain: "solana", type: "native", symbol: "SOL", decimals: 9 },
}

const mockRpc = (responses: Record<string, unknown>) =>
  makeMockFetchAdapter({
    handlers: [
      [
        "rpc.test",
        (req) => {
          const body = JSON.parse(
            typeof req.body === "string"
              ? req.body
              : new TextDecoder().decode(req.body as Uint8Array),
          ) as { method: string }
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

// Stateful variant: each method maps to a sequence of responses, one
// returned per call. Once the sequence is exhausted the last element
// is reused. `null` is a legitimate result (e.g. getTransaction
// returning null before the indexer catches up); `undefined` means
// "no mock registered for this method".
const mockRpcSequence = (
  responses: Record<string, ReadonlyArray<unknown>>,
  counts?: Record<string, number>,
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
          ) as { method: string }
          const seq = responses[body.method]
          if (!seq) {
            return {
              status: 200,
              body: {
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32601, message: "no mock" },
              },
            }
          }
          const n = counts ? (counts[body.method] ?? 0) : 0
          if (counts) counts[body.method] = n + 1
          const result = seq[Math.min(n, seq.length - 1)]
          return {
            status: 200,
            body: { jsonrpc: "2.0", id: 1, result },
          }
        },
      ],
    ],
    fallbackTo404: true,
  })

const blockhashMock = mockRpc({
  getLatestBlockhash: {
    context: { slot: 100 },
    value: {
      blockhash: "FwRYtTPRk5N4wUeP87rTw9kQVSwigB6kbikGzzeCMrW5",
      lastValidBlockHeight: 200,
    },
  },
})

// Anchor discriminator for "global:deposit_for_burn" (first 8 bytes of sha256).
const BURN_DISCRIMINATOR = sha256(
  new TextEncoder().encode("global:deposit_for_burn"),
).slice(0, 8)

const MINT_DISCRIMINATOR = sha256(
  new TextEncoder().encode("global:receive_message"),
).slice(0, 8)

describe("SolanaChainAdapter CCTP V1", () => {
  it("buildCctpBurnTx produces a ComputeBudget + depositForBurn ix pair targeted at Circle's TokenMessengerMinter program", async () => {
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      const seed = new Uint8Array(32).fill(0x11)
      const pk = ed25519.getPublicKey(seed)
      const from = new PublicKey(pk).toBase58()
      // EVM-style 20-byte hex recipient; adapter should left-pad to 32.
      const recipient = "0xABCDEF0123456789abcdef0123456789ABCDEF01"
      return yield* adapter.buildCctpBurnTx({
        from,
        destinationDomain: 0,
        recipient,
        amount: 5_000_000n,
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, blockhashMock))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("cctp-burn")
    expect(payload.instructions).toHaveLength(2)
    // Second instruction is the CCTP burn; its programId is TMM.
    const burnIx = payload.instructions[1]
    expect(burnIx.programId).toBe(
      DEFAULT_SOLANA_CCTP_V1.tokenMessengerMinterProgramId,
    )
    // 17 accounts — owner, event_rent_payer (owner), sender_authority,
    // burn_token_account, mt_state, tm_state, remote_tm, token_minter,
    // local_token, mint, message_sent_event_data, mt_program, tmm_program,
    // token_program, system_program, event_authority, program.
    expect(burnIx.keys).toHaveLength(17)
    // Payload carries the ephemeral signer seed for attachSignature.
    expect(payload.ephemeralSignerSecretBase58).toBeDefined()
    // The `message_sent_event_data` pubkey in the ix matches that seed.
    const eventPkBase58 = burnIx.keys[10].pubkey
    const eventPkBytes = new PublicKey(eventPkBase58).toBytes()
    expect(eventPkBytes).toHaveLength(32)
  })

  it("buildCctpBurnTx embeds the Anchor deposit_for_burn discriminator and LE-encoded args", async () => {
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      const seed = new Uint8Array(32).fill(0x22)
      const pk = ed25519.getPublicKey(seed)
      const from = new PublicKey(pk).toBase58()
      return yield* adapter.buildCctpBurnTx({
        from,
        destinationDomain: 9, // Aptos
        recipient: "0x" + "ab".repeat(32),
        amount: 1_000_000n,
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, blockhashMock))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    const burnIx = payload.instructions[1]
    // Decode the base58 instruction data and verify the Anchor layout.
    const { base58Decode } = await import(
      "../src/services/keyring-crypto.js"
    )
    const data: Uint8Array = base58Decode(burnIx.dataBase58)
    expect(data.length).toBe(8 + 8 + 4 + 32)
    expect(Array.from(data.slice(0, 8))).toEqual(
      Array.from(BURN_DISCRIMINATOR),
    )
    // amount LE (1_000_000 = 0x0f4240 = [0x40, 0x42, 0x0f, 0, 0, 0, 0, 0])
    expect(data[8]).toBe(0x40)
    expect(data[9]).toBe(0x42)
    expect(data[10]).toBe(0x0f)
    // destinationDomain LE (9)
    expect(data[16]).toBe(9)
    expect(data[17]).toBe(0)
    // mintRecipient (32 bytes, 0xab repeated)
    expect(Array.from(data.slice(20, 52))).toEqual(new Array(32).fill(0xab))
  })

  it("buildCctpBurnTx allows overriding program IDs via cctpContracts", async () => {
    const customTmm = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"
    const customMt = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"
    const customUsdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" // devnet USDC
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
        cctpContracts: {
          tokenMessengerMinterProgramId: customTmm,
          messageTransmitterProgramId: customMt,
          usdcMint: customUsdc,
        },
      })
      const seed = new Uint8Array(32).fill(0x33)
      const pk = ed25519.getPublicKey(seed)
      return yield* adapter.buildCctpBurnTx({
        from: new PublicKey(pk).toBase58(),
        destinationDomain: 0,
        recipient: "0x" + "cc".repeat(20),
        amount: 100n,
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, blockhashMock))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const burnIx = (tx.payload as any).instructions[1]
    expect(burnIx.programId).toBe(customTmm)
    // mt program appears at index 11.
    expect(burnIx.keys[11].pubkey).toBe(customMt)
    // usdc mint at index 9.
    expect(burnIx.keys[9].pubkey).toBe(customUsdc)
  })

  it("buildMintTx derives PDAs from the parsed CCTP V1 message header", async () => {
    // Craft a synthetic 248-byte CCTP V1 message:
    //   header(116): version(4)|src(4)|dst(4)|nonce(8)|sender(32)|recipient(32)|destCaller(32)
    //   body(132):   version(4)|burnToken(32)|mintRecipient(32)|amount(32)|messageSender(32)
    const message = new Uint8Array(248)
    // sourceDomain = 0 (Ethereum), offset 4-8 BE
    message[4] = 0
    message[5] = 0
    message[6] = 0
    message[7] = 0
    // destDomain = 5 (Solana)
    message[8] = 0
    message[9] = 0
    message[10] = 0
    message[11] = 5
    // nonce = 42 (u64 BE) at offset 12-20
    message[19] = 42
    // burnToken at body offset 116+4 = 120, filled with 0xa0 bytes
    for (let i = 120; i < 120 + 32; i++) message[i] = 0xa0

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      const seed = new Uint8Array(32).fill(0x44)
      const recipient = new PublicKey(ed25519.getPublicKey(seed)).toBase58()
      return yield* adapter.buildMintTx({
        recipient,
        messageBytes: message,
        attestation: "0x" + "aa".repeat(65),
      })
    })
    const tx = await Effect.runPromise(Effect.provide(program, blockhashMock))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = tx.payload as any
    expect(payload.kind).toBe("cctp-mint")
    const mintIx = payload.instructions[1]
    expect(mintIx.programId).toBe(
      DEFAULT_SOLANA_CCTP_V1.messageTransmitterProgramId,
    )
    const { base58Decode } = await import(
      "../src/services/keyring-crypto.js"
    )
    const data: Uint8Array = base58Decode(mintIx.dataBase58)
    expect(Array.from(data.slice(0, 8))).toEqual(
      Array.from(MINT_DISCRIMINATOR),
    )
    // Message len u32 LE at offset 8
    expect(data[8]).toBe(248)
    // Attestation starts after the message bytes. Expected 65 bytes (hex pair count).
    const expectedMsgEnd = 12 + 248
    const attLenLo = data[expectedMsgEnd]
    expect(attLenLo).toBe(65)
  })

  it("signs a CCTP burn tx with both the user key and the ephemeral event-data key", async () => {
    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      const seed = new Uint8Array(32).fill(0x55)
      const pk = ed25519.getPublicKey(seed)
      const from = new PublicKey(pk).toBase58()
      const tx = yield* adapter.buildCctpBurnTx({
        from,
        destinationDomain: 0,
        recipient: "0x" + "ff".repeat(20),
        amount: 999n,
      })
      return yield* adapter.sign(tx, seed)
    })
    const signed = await Effect.runPromise(Effect.provide(program, blockhashMock))
    // A signed Solana tx with two signers has [sig_count: 2][sig1 64][sig2 64] at its head.
    // `sig_count` is serialized as a compact-u16 — a single byte 0x02 for value 2.
    expect(signed.raw[0]).toBe(0x02)
    expect(signed.raw.length).toBeGreaterThan(1 + 64 + 64)
  })

  it("extractBurnMessageFromTx reads msg_len at offset 40 on the MessageSent account", async () => {
    // Regression: Circle's V1 MessageSent Anchor account layout is
    // [8 disc | 32 rent_payer | 4 u32 LE msg_len | N bytes msg] — the
    // length sits at offset 40, not 48. A prior build hardcoded 48 and
    // every Solana-origin burn failed reconciliation.
    const MSG_LEN = 248
    const message = new Uint8Array(MSG_LEN)
    // CCTP V1 outer message header (all big-endian):
    //   version(4)|sourceDomain(4)|destDomain(4)|nonce(8)|sender(32)|recipient(32)|destCaller(32)
    // sourceDomain = 5 (Solana), destDomain = 0 (Ethereum), nonce = 42.
    message[7] = 5
    message[11] = 0
    message[19] = 42

    const account = new Uint8Array(8 + 32 + 4 + MSG_LEN)
    for (let i = 0; i < 8; i++) account[i] = i + 1 // arbitrary discriminator
    for (let i = 8; i < 40; i++) account[i] = 0xcc // arbitrary rent_payer
    // u32 LE msg_len = 248 at offset 40
    account[40] = MSG_LEN & 0xff
    account[41] = (MSG_LEN >>> 8) & 0xff
    account[42] = (MSG_LEN >>> 16) & 0xff
    account[43] = (MSG_LEN >>> 24) & 0xff
    account.set(message, 44)

    let binary = ""
    for (const b of account) binary += String.fromCharCode(b)
    const accountB64 = btoa(binary)

    const eventAccountKey = new PublicKey(
      new Uint8Array(32).fill(0x11),
    ).toBase58()
    const tmm = DEFAULT_SOLANA_CCTP_V1.tokenMessengerMinterProgramId

    const fixtureMock = mockRpc({
      getTransaction: {
        meta: { err: null },
        transaction: {
          message: {
            accountKeys: [tmm, eventAccountKey],
            instructions: [
              {
                programIdIndex: 0,
                // 11 entries — index 10 is the message_sent_event_data
                // account (accountKeys[1]).
                accounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
              },
            ],
          },
        },
      },
      getAccountInfo: {
        context: { slot: 100 },
        value: { data: [accountB64, "base64"] },
      },
    })

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
      })
      return yield* adapter.extractBurnMessageFromTx("5aakZGdummysignature")
    })
    const burn = await Effect.runPromise(Effect.provide(program, fixtureMock))
    expect(burn).not.toBeNull()
    expect(burn!.sourceDomain).toBe(5)
    expect(burn!.destDomain).toBe(0)
    expect(burn!.nonce).toBe(42n)
    expect(burn!.messageBytes!.length).toBe(248)
  })

  it("extractBurnMessageFromTx retries getTransaction while the history indexer catches up", async () => {
    // Regression: `broadcast` returns once getSignatureStatuses hits
    // `confirmed`, but Helius and most public RPCs take 1–3s longer
    // to serve the tx via getTransaction. A single-shot fetch raced
    // that indexer — the null response surfaced as a bogus
    // "no MessageSent account" error. The adapter should retry
    // getTransaction and absorb the lag before giving up.
    const MSG_LEN = 248
    const message = new Uint8Array(MSG_LEN)
    message[7] = 5 // sourceDomain = 5 (Solana)
    message[11] = 0 // destDomain = 0
    message[19] = 7 // nonce = 7

    const account = new Uint8Array(8 + 32 + 4 + MSG_LEN)
    for (let i = 0; i < 8; i++) account[i] = i + 1
    for (let i = 8; i < 40; i++) account[i] = 0xcc
    account[40] = MSG_LEN & 0xff
    account[41] = (MSG_LEN >>> 8) & 0xff
    account[42] = (MSG_LEN >>> 16) & 0xff
    account[43] = (MSG_LEN >>> 24) & 0xff
    account.set(message, 44)
    let binary = ""
    for (const b of account) binary += String.fromCharCode(b)
    const accountB64 = btoa(binary)

    const eventAccountKey = new PublicKey(
      new Uint8Array(32).fill(0x22),
    ).toBase58()
    const tmm = DEFAULT_SOLANA_CCTP_V1.tokenMessengerMinterProgramId

    const realTxResponse = {
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [tmm, eventAccountKey],
          instructions: [
            {
              programIdIndex: 0,
              accounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            },
          ],
        },
      },
    }
    const realAccountInfo = {
      context: { slot: 100 },
      value: { data: [accountB64, "base64"] },
    }

    const counts: Record<string, number> = {}
    const racingMock = mockRpcSequence(
      {
        // First 3 calls race the indexer and come back empty, the 4th
        // finally returns the indexed tx.
        getTransaction: [null, null, null, realTxResponse],
        getAccountInfo: [realAccountInfo],
      },
      counts,
    )

    const program = Effect.gen(function* () {
      const fetcher = yield* FetchAdapter
      const adapter = makeSolanaChainAdapter({
        chainConfig: solChain,
        fetcher,
        // Keep the test fast — interval of 10ms × 5 attempts still
        // exercises the exact retry loop shipped to production.
        reconcileRetry: { attempts: 5, intervalMs: 10 },
      })
      return yield* adapter.extractBurnMessageFromTx("5aakZGdummysignature")
    })
    const burn = await Effect.runPromise(Effect.provide(program, racingMock))
    expect(burn).not.toBeNull()
    expect(burn!.sourceDomain).toBe(5)
    expect(burn!.destDomain).toBe(0)
    expect(burn!.nonce).toBe(7n)
    expect(burn!.messageBytes!.length).toBe(248)
    // 4 getTransaction calls: 3 racing the indexer + 1 successful.
    expect(counts.getTransaction).toBe(4)
  })
})
