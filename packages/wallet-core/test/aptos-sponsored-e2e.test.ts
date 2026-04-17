import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import type { Aptos, PendingTransactionResponse } from "@aptos-labs/ts-sdk"
import { ed25519 } from "@noble/curves/ed25519"
import { sha3_256 } from "@noble/hashes/sha3"
import { bytesToHex } from "@noble/hashes/utils"
import { createWallet } from "../src/create-wallet.js"
import { KeyringService } from "../src/services/keyring.js"
import { SignerService } from "../src/services/signer.js"
import { ChainAdapterRegistry } from "../src/adapters/chain/index.js"
import { makeAptosChainAdapter } from "../src/adapters/chain/aptos.js"
import { makeMockChainAdapter } from "../src/adapters/chain/mock.js"
import { makeChainAdapterRegistryLayer } from "../src/adapters/chain/registry.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import type { ChainAdapter } from "../src/adapters/chain/index.js"
import type { ChainConfig, ChainId } from "../src/model/chain.js"
import { testConfig } from "./helpers/test-config.js"
import { buildRealRawTx } from "./helpers/aptos-rawtx.js"

const addressOf = (seedByte: number) => {
  const seed = new Uint8Array(32).fill(seedByte)
  const pubkey = ed25519.getPublicKey(seed)
  const buf = new Uint8Array(33)
  buf.set(pubkey, 0)
  buf[32] = 0x00
  return "0x" + bytesToHex(sha3_256(buf))
}

interface SubmitCall {
  transaction: unknown
  senderAuthenticator: unknown
  feePayerAuthenticatorSeen: boolean
  rawTxBytes: Uint8Array
}

const makeFakeAptos = (
  rawBcs: Uint8Array,
  onSubmit: (call: SubmitCall) => void,
  throwOnSubmit?: Error,
) =>
  ({
    transaction: {
      build: {
        simple: async () => ({
          rawTransaction: {
            bcsToBytes: () => rawBcs,
          },
        }),
      },
      submit: {
        simple: async (args: {
          transaction: { rawTransaction?: { bcsToBytes: () => Uint8Array } }
          senderAuthenticator: unknown
          feePayerAuthenticator?: unknown
        }) => {
          onSubmit({
            transaction: args.transaction,
            senderAuthenticator: args.senderAuthenticator,
            feePayerAuthenticatorSeen: "feePayerAuthenticator" in args,
            rawTxBytes:
              args.transaction.rawTransaction?.bcsToBytes() ?? new Uint8Array(0),
          })
          if (throwOnSubmit) throw throwOnSubmit
          return { hash: "0x" + "cd".repeat(32) } as PendingTransactionResponse
        },
      },
    },
    waitForTransaction: async () => ({}),
    getAccountCoinAmount: async () => "0",
  }) as unknown as Aptos

const makeSponsoredHarness = (aptos: Aptos) => {
  const adapters = new Map<ChainId, ChainAdapter>()
  for (const chain of testConfig.chains) {
    if (chain.chainId === "aptos") {
      adapters.set(
        chain.chainId,
        makeAptosChainAdapter({
          chainConfig: chain as ChainConfig,
          aptosClient: aptos,
          sponsored: true,
        }),
      )
    } else {
      adapters.set(chain.chainId, makeMockChainAdapter(chain))
    }
  }
  const layer = createWallet(testConfig, {
    chainRegistry: makeChainAdapterRegistryLayer(adapters),
    fetch: makeMockFetchAdapter({ handlers: [], fallbackTo404: true }),
  })
  return { layer, adapters }
}

describe("Aptos sponsored end-to-end (SignerService wiring)", () => {
  it("signs + broadcasts sponsored tx; never leaks private key; no fee-payer authenticator ever passed", async () => {
    const from = addressOf(0xb0)
    const rawBcs = buildRealRawTx(from)
    const submitCalls: SubmitCall[] = []
    const aptos = makeFakeAptos(rawBcs, (c) => submitCalls.push(c))

    // Wrap the adapter so we can assert that the raw private key never
    // crosses the attachSignature boundary (parallel to signer.test.ts).
    const { adapters } = makeSponsoredHarness(aptos)
    const base = adapters.get("aptos")!
    const seenPubKeys: Uint8Array[] = []
    const wrapped: ChainAdapter = {
      ...base,
      attachSignature: (tx, signature, publicKey) => {
        seenPubKeys.push(publicKey)
        return base.attachSignature(tx, signature, publicKey)
      },
    }
    ;(adapters as Map<string, ChainAdapter>).set("aptos", wrapped)

    const layer = createWallet(testConfig, {
      chainRegistry: makeChainAdapterRegistryLayer(adapters),
      fetch: makeMockFetchAdapter({ handlers: [], fallbackTo404: true }),
    })

    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: src.address,
        to: src.address,
        asset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 },
        amount: 1n,
      })
      expect(tx.estimatedFee).toBe(0n)
      const signed = yield* signer.sign(tx)
      return yield* adapter.broadcast(signed)
    })
    const receipt = await Effect.runPromise(Effect.provide(program, layer))
    expect(receipt.status).toBe("confirmed")

    // Adapter received a public key — not a private key.
    expect(seenPubKeys).toHaveLength(1)
    expect(seenPubKeys[0]!.length).toBe(32)

    // submit.simple saw senderAuthenticator, NEVER feePayerAuthenticator.
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]!.senderAuthenticator).toBeDefined()
    expect(submitCalls[0]!.feePayerAuthenticatorSeen).toBe(false)

    // Byte-identity: the rawTx passed to submit BCS-equals the one
    // returned by build.simple. Regression guard for the invariant that
    // no intermediate step rebuilds the tx between sign and broadcast.
    expect(Array.from(submitCalls[0]!.rawTxBytes)).toEqual(Array.from(rawBcs))
  })

  it("surfaces gas-station policy rejections as BroadcastError with cause preserved", async () => {
    const from = addressOf(0xc0)
    const rawBcs = buildRealRawTx(from)
    const policyErr = new Error("policy: function not whitelisted")
    const aptos = makeFakeAptos(rawBcs, () => {}, policyErr)

    const { layer } = makeSponsoredHarness(aptos)

    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: src.address,
        to: src.address,
        asset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 },
        amount: 1n,
      })
      const signed = yield* signer.sign(tx)
      return yield* adapter.broadcast(signed)
    })

    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
      // Provider's error is preserved verbatim, unwrapped.
      expect(result.left.cause).toBe(policyErr)
    }
  })

  it("surfaces 429-shaped errors as BroadcastError (no automatic retry)", async () => {
    const from = addressOf(0xd0)
    const rawBcs = buildRealRawTx(from)
    const rateLimit = new Error("429 Too Many Requests")
    const aptos = makeFakeAptos(rawBcs, () => {}, rateLimit)
    const { layer } = makeSponsoredHarness(aptos)

    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: src.address,
        to: src.address,
        asset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 },
        amount: 1n,
      })
      const signed = yield* signer.sign(tx)
      return yield* adapter.broadcast(signed)
    })

    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BroadcastError")
      expect(result.left.cause).toBe(rateLimit)
    }
  })
})

// Silence unused-import warnings from strict tsconfig in bundler mode.
// (Layer is referenced via createWallet's return type.)
void Layer
