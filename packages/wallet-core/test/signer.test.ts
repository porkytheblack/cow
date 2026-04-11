import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createWallet } from "../src/create-wallet.js"
import { KeyringService } from "../src/services/keyring.js"
import { SignerService } from "../src/services/signer.js"
import { DenyingAuthGate } from "../src/services/auth-gate.js"
import { ChainAdapterRegistry } from "../src/adapters/chain/index.js"
import { makeChainAdapterRegistryLayer } from "../src/adapters/chain/registry.js"
import { makeMockChainAdapter } from "../src/adapters/chain/mock.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import type { ChainId } from "../src/model/chain.js"
import type { ChainAdapter } from "../src/adapters/chain/index.js"
import { testConfig } from "./helpers/test-config.js"
import { makeTestHarness } from "./helpers/test-layers.js"

describe("SignerService", () => {
  it("signs a transaction when auth is approved", async () => {
    const harness = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: src.address,
        to: "0xdeadbeef",
        asset: { chain: "aptos", type: "token", symbol: "USDC", decimals: 6 },
        amount: 1_000n,
      })
      return yield* signer.sign(tx)
    })
    const signed = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    expect(signed.hash).toBeTypeOf("string")
    expect(signed.raw.length).toBeGreaterThan(0)
  })

  it("never hands the raw private key to the chain adapter", async () => {
    // Regression: the old SignerService pulled the private key out of
    // KeyringService and handed it to ChainAdapter.sign. The new flow
    // must go through buildSigningMessage → signBytes → attachSignature
    // and the adapter must never see raw key material on the boundary.
    const harness = makeTestHarness()
    const seenSignatures: Uint8Array[] = []
    const seenPublicKeys: Uint8Array[] = []
    // Wrap the aptos adapter so we can observe what attachSignature is
    // called with. signBytes internally calls signMessageForChain which
    // returns a 64-byte ed25519 signature for aptos — distinctly
    // shorter than a mnemonic-derived private key (also 32 bytes), so
    // we additionally verify the pubkey is a valid curve output by
    // comparing it against the derived key's published pubkey.
    const originalAdapter = harness.adapters.get("aptos")!
    const wrapped = {
      ...originalAdapter,
      attachSignature: (
        tx: Parameters<typeof originalAdapter.attachSignature>[0],
        signature: Uint8Array,
        publicKey: Uint8Array,
      ) => {
        seenSignatures.push(signature)
        seenPublicKeys.push(publicKey)
        return originalAdapter.attachSignature(tx, signature, publicKey)
      },
    }
    ;(harness.adapters as Map<string, ChainAdapter>).set("aptos", wrapped)

    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const { keys } = yield* keyring.generate()
      const src = keys.find((k) => k.chain === "aptos")!
      const tx = yield* originalAdapter.buildTransferTx({
        from: src.address,
        to: "0xdeadbeef",
        asset: { chain: "aptos", type: "token", symbol: "USDC", decimals: 6 },
        amount: 1_000n,
      })
      yield* signer.sign(tx)
      return src
    })
    const src = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    // Adapter saw exactly one signature + pubkey pair.
    expect(seenSignatures).toHaveLength(1)
    expect(seenPublicKeys).toHaveLength(1)
    // ed25519 signatures are 64 bytes; the private key is 32 bytes so
    // even a length check rules out the old pk-leaking shape.
    expect(seenSignatures[0]!.length).toBe(64)
    // The adapter received the derived public key, not some secret.
    expect(Array.from(seenPublicKeys[0]!)).toEqual(Array.from(src.publicKey))
  })

  it("propagates AuthDeniedError when the gate denies", async () => {
    // Build a custom wallet with the denying auth gate.
    const adapters = new Map<ChainId, ChainAdapter>()
    for (const chain of testConfig.chains) {
      adapters.set(chain.chainId, makeMockChainAdapter(chain))
    }
    const fetchLayer = makeMockFetchAdapter({ handlers: [], fallbackTo404: true })
    const layer = createWallet(testConfig, {
      authGate: DenyingAuthGate,
      chainRegistry: makeChainAdapterRegistryLayer(adapters),
      fetch: fetchLayer,
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
        to: "0xdeadbeef",
        asset: { chain: "aptos", type: "token", symbol: "USDC", decimals: 6 },
        amount: 1_000n,
      })
      return yield* signer.sign(tx)
    })

    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AuthDeniedError")
    }
  })
})
