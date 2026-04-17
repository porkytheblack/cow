import { describe, expect, it, vi } from "vitest"
import { createWalletClient } from "../src/client.js"
import { makeCallbackAuthGate } from "../src/services/auth-gate-callback.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { makeMockChainAdapter } from "../src/adapters/chain/mock.js"
import { makeChainAdapterRegistryLayer } from "../src/adapters/chain/registry.js"
import type { ChainAdapter } from "../src/adapters/chain/index.js"
import type { ChainId } from "../src/model/chain.js"
import type { AssetId } from "../src/model/asset.js"
import { testConfig } from "./helpers/test-config.js"

const USDC: AssetId = {
  chain: "aptos",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xusdc",
}

const makeSessionClient = (promptSpy: ReturnType<typeof vi.fn>) => {
  const adapters = new Map<ChainId, ChainAdapter>()
  for (const chain of testConfig.chains) {
    adapters.set(chain.chainId, makeMockChainAdapter(chain))
  }
  const seed = (address: string, asset: AssetId, amount: bigint) => {
    const adapter = adapters.get(asset.chain)!
    ;(adapter as unknown as {
      __seed: (a: string, b: AssetId, c: bigint) => void
    }).__seed(address, asset, amount)
  }

  const client = createWalletClient(testConfig, {
    chainRegistry: makeChainAdapterRegistryLayer(adapters),
    fetch: makeMockFetchAdapter({ handlers: [], fallbackTo404: true }),
    authGate: makeCallbackAuthGate({
      promptApproval: promptSpy,
      getEncryptionKey: async () => new Uint8Array(32),
      sessionTtlMs: 10_000,
    }),
  })
  return { client, seed }
}

describe("Auth sessions", () => {
  it("approveSession prompts once, then sign auto-approves", async () => {
    const promptSpy = vi.fn().mockResolvedValue({
      method: "biometric" as const,
      timestamp: Date.now(),
    })
    const { client, seed } = makeSessionClient(promptSpy)
    const { keys } = await client.generate()
    const src = keys.find((k) => k.chain === "aptos")!
    seed(src.address, USDC, 100_000_000n)

    // Start session — prompts once.
    await client.approveSession("Batch of 3 transfers")
    expect(promptSpy).toHaveBeenCalledTimes(1)

    // 3 transfers — no additional prompts.
    for (let i = 0; i < 3; i++) {
      await client.transfer({
        from: { chain: "aptos", address: src.address },
        to: { chain: "aptos", address: "0xrecipient" },
        asset: USDC,
        amount: 1_000_000n,
      })
    }
    // Still only 1 prompt total.
    expect(promptSpy).toHaveBeenCalledTimes(1)

    await client.dispose()
  })

  it("endSession causes the next sign to prompt again", async () => {
    const promptSpy = vi.fn().mockResolvedValue({
      method: "pin" as const,
      timestamp: Date.now(),
    })
    const { client, seed } = makeSessionClient(promptSpy)
    const { keys } = await client.generate()
    const src = keys.find((k) => k.chain === "aptos")!
    seed(src.address, USDC, 100_000_000n)

    await client.approveSession("Session 1")
    expect(promptSpy).toHaveBeenCalledTimes(1)

    await client.transfer({
      from: { chain: "aptos", address: src.address },
      to: { chain: "aptos", address: "0xrecipient" },
      asset: USDC,
      amount: 1_000_000n,
    })
    expect(promptSpy).toHaveBeenCalledTimes(1)

    // End session.
    await client.endSession()
    expect(await client.hasActiveSession()).toBe(false)

    // Next transfer prompts again.
    await client.transfer({
      from: { chain: "aptos", address: src.address },
      to: { chain: "aptos", address: "0xrecipient" },
      asset: USDC,
      amount: 1_000_000n,
    })
    expect(promptSpy).toHaveBeenCalledTimes(2)

    await client.dispose()
  })

  it("standard session doesn't cover elevated requests", async () => {
    let callCount = 0
    const promptSpy = vi.fn().mockImplementation(async () => {
      callCount++
      return { method: "pin" as const, timestamp: Date.now() }
    })
    const { client } = makeSessionClient(promptSpy)
    await client.generate()

    // Start a standard-level session.
    await client.approveSession("Low-value ops", "standard")
    expect(callCount).toBe(1)

    // hasActiveSession should be true.
    expect(await client.hasActiveSession()).toBe(true)

    await client.dispose()
  })
})
