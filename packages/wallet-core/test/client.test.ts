import { describe, expect, it } from "vitest"
import { createWalletClient } from "../src/client.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { makeMockChainAdapter } from "../src/adapters/chain/mock.js"
import { makeChainAdapterRegistryLayer } from "../src/adapters/chain/registry.js"
import type { ChainAdapter } from "../src/adapters/chain/index.js"
import type { AssetId } from "../src/model/asset.js"
import type { ChainId } from "../src/model/chain.js"
import { testConfig } from "./helpers/test-config.js"

const makeClient = () => {
  const adapters = new Map<ChainId, ChainAdapter>()
  for (const chain of testConfig.chains) {
    adapters.set(chain.chainId, makeMockChainAdapter(chain))
  }

  const seed = (address: string, asset: AssetId, amount: bigint) => {
    const adapter = adapters.get(asset.chain)
    if (!adapter) throw new Error(`No adapter for ${String(asset.chain)}`)
    ;(adapter as unknown as {
      __seed: (a: string, b: AssetId, c: bigint) => void
    }).__seed(address, asset, amount)
  }

  const mockFetch = makeMockFetchAdapter({
    handlers: [
      [
        "mock-iris.circle.test",
        () => ({
          status: 200,
          body: {
            messages: [
              {
                status: "complete",
                attestation: "0x" + "ab".repeat(65),
              },
            ],
          },
        }),
      ],
    ],
    fallbackTo404: true,
  })

  const client = createWalletClient(testConfig, {
    chainRegistry: makeChainAdapterRegistryLayer(adapters),
    fetch: mockFetch,
  })

  return { client, seed }
}

const USDC_APTOS: AssetId = {
  chain: "aptos",
  type: "token",
  symbol: "USDC",
  decimals: 6,
  address: "0xusdc",
}

describe("WalletClient (promise API)", () => {
  it("generate + listKeys without any Effect imports", async () => {
    const { client } = makeClient()
    const { mnemonic, keys } = await client.generate()
    expect(mnemonic.phrase.split(" ").length).toBe(12)
    expect(keys.length).toBe(3)

    const all = await client.listKeys()
    expect(all.length).toBe(3)
  })

  it("importMnemonic is deterministic", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    const { client: c1 } = makeClient()
    const { client: c2 } = makeClient()
    const k1 = await c1.importMnemonic(phrase)
    const k2 = await c2.importMnemonic(phrase)
    expect(k1.map((k) => k.address)).toEqual(k2.map((k) => k.address))
  })

  it("addAccount + getKey by address", async () => {
    const { client } = makeClient()
    await client.generate()
    const acct1 = await client.addAccount("aptos")
    expect(acct1.accountIndex).toBe(1)

    const found = await client.getKey("aptos", acct1.address)
    expect(found.address).toBe(acct1.address)
  })

  it("getBalance returns zero for an unseeded address", async () => {
    const { client } = makeClient()
    const { keys } = await client.generate()
    const aptos = keys.find((k) => k.chain === "aptos")!
    const result = await client.getBalance("aptos", aptos.address, USDC_APTOS)
    expect(result.balance).toBe(0n)
  })

  it("getPortfolio() with no args auto-lists all keys", async () => {
    const { client, seed } = makeClient()
    const { keys } = await client.generate()
    const aptos = keys.find((k) => k.chain === "aptos")!
    seed(aptos.address, USDC_APTOS, 5_000_000n)
    const portfolio = await client.getPortfolio()
    const total = portfolio.balances.reduce((s, b) => s + b.balance, 0n)
    expect(total).toBeGreaterThanOrEqual(5_000_000n)
  })

  it("transfer executes a same-chain transfer end to end", async () => {
    const { client, seed } = makeClient()
    const { keys } = await client.generate()
    const src = keys.find((k) => k.chain === "aptos")!
    seed(src.address, USDC_APTOS, 100_000_000n)

    const result = await client.transfer({
      from: { chain: "aptos", address: src.address },
      to: { chain: "aptos", address: "0xdeadbeef" },
      asset: USDC_APTOS,
      amount: 10_000_000n,
    })
    expect(result.status).toBe("completed")
    expect(result.steps.length).toBe(1)
  })

  it("transfer rejects on insufficient balance", async () => {
    const { client } = makeClient()
    const { keys } = await client.generate()
    const src = keys.find((k) => k.chain === "aptos")!

    const didThrow = await client
      .transfer({
        from: { chain: "aptos", address: src.address },
        to: { chain: "aptos", address: "0xdeadbeef" },
        asset: USDC_APTOS,
        amount: 10_000_000n,
      })
      .then(() => false)
      .catch(() => true)

    expect(didThrow).toBe(true)
  })

  it("cross-chain CCTP transfer works via promises", async () => {
    const { client, seed } = makeClient()
    const { keys } = await client.generate()
    const src = keys.find((k) => k.chain === "aptos")!
    const dst = keys.find((k) => k.chain === "evm:1")!
    seed(src.address, USDC_APTOS, 100_000_000n)

    const result = await client.transfer({
      from: { chain: "aptos", address: src.address },
      to: { chain: "evm:1", address: dst.address },
      asset: USDC_APTOS,
      amount: 10_000_000n,
    })
    expect(result.status).toBe("completed")
  })

  it("exportBackup + importBackup round-trips", async () => {
    const { client } = makeClient()
    const { keys } = await client.generate()
    const encKey = new Uint8Array(32).fill(0x77)
    const bundle = await client.exportBackup(encKey)
    const restored = await client.importBackup(bundle, encKey)
    expect(restored.map((k) => k.address).sort()).toEqual(
      keys.map((k) => k.address).sort(),
    )
  })

  it("planTransfer returns a TransferPlan without executing", async () => {
    const { client } = makeClient()
    const { keys } = await client.generate()
    const src = keys.find((k) => k.chain === "aptos")!
    const plan = await client.planTransfer({
      from: { chain: "aptos", address: src.address },
      to: { chain: "aptos", address: "0xdeadbeef" },
      asset: USDC_APTOS,
      amount: 1_000n,
    })
    expect(plan.isCrossChain).toBe(false)
    expect(plan.steps.length).toBe(1)
  })

  it("layer escape hatch exposes the underlying Effect layer", () => {
    const { client } = makeClient()
    expect(client.layer).toBeDefined()
  })
})
