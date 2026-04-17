import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { KeyringService } from "../src/services/keyring.js"
import { SignerService } from "../src/services/signer.js"
import { BalanceService } from "../src/services/balance.js"
import { ChainAdapterRegistry } from "../src/adapters/chain/index.js"
import type { AssetId } from "../src/model/asset.js"
import { makeTestHarness } from "./helpers/test-layers.js"

describe("Multi-account support", () => {
  it("addAccount derives a second key at a different BIP-44 account index", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const { keys: initial } = yield* keyring.generate()
      const second = yield* keyring.addAccount("aptos")
      return { initial, second }
    })
    const { initial, second } = await Effect.runPromise(
      Effect.provide(program, layer),
    )
    const firstAptos = initial.find((k) => k.chain === "aptos")!
    expect(firstAptos.accountIndex).toBe(0)
    expect(second.accountIndex).toBe(1)
    expect(second.chain).toBe("aptos")
    expect(second.address).not.toBe(firstAptos.address)
    expect(second.path.path).not.toBe(firstAptos.path.path)
    expect(second.path.accountIndex).toBe(1)
  })

  it("listKeys returns all accounts across all chains", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.generate()
      yield* keyring.addAccount("evm:1")
      yield* keyring.addAccount("evm:1")
      return yield* keyring.listKeys()
    })
    const keys = await Effect.runPromise(Effect.provide(program, layer))
    const evmKeys = keys.filter((k) => k.chain === "evm:1")
    expect(evmKeys).toHaveLength(3) // index 0, 1, 2
    expect(evmKeys.map((k) => k.accountIndex).sort()).toEqual([0, 1, 2])
    const aptosKeys = keys.filter((k) => k.chain === "aptos")
    expect(aptosKeys).toHaveLength(1) // only index 0
  })

  it("getKey(chain, address) picks the right account", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.generate()
      const acct1 = yield* keyring.addAccount("solana")
      const found = yield* keyring.getKey("solana", acct1.address)
      return { acct1, found }
    })
    const { acct1, found } = await Effect.runPromise(
      Effect.provide(program, layer),
    )
    expect(found.address).toBe(acct1.address)
    expect(found.accountIndex).toBe(1)
  })

  it("getKey(chain) still returns account 0 by default", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.generate()
      yield* keyring.addAccount("aptos")
      return yield* keyring.getKey("aptos")
    })
    const key = await Effect.runPromise(Effect.provide(program, layer))
    expect(key.accountIndex).toBe(0)
  })

  it("SignerService.sign resolves the correct account from tx.from", async () => {
    const harness = makeTestHarness()
    const USDC: AssetId = {
      chain: "aptos",
      type: "token",
      symbol: "USDC",
      decimals: 6,
    }
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const signer = yield* SignerService
      const registry = yield* ChainAdapterRegistry

      yield* keyring.generate()
      const acct1 = yield* keyring.addAccount("aptos")
      harness.seed(acct1.address, USDC, 50_000_000n)

      const adapter = yield* registry.get("aptos")
      const tx = yield* adapter.buildTransferTx({
        from: acct1.address,
        to: "0xrecipient",
        asset: USDC,
        amount: 1_000n,
      })
      const signed = yield* signer.sign(tx)
      return { acct1, signed }
    })
    const { acct1, signed } = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    expect(signed.raw.length).toBeGreaterThan(0)
    expect(signed.unsigned.from).toBe(acct1.address)
  })

  it("BalanceService.getPortfolio aggregates balances across multiple accounts", async () => {
    const harness = makeTestHarness()
    const USDC: AssetId = {
      chain: "aptos",
      type: "token",
      symbol: "USDC",
      decimals: 6,
    }
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const balance = yield* BalanceService

      yield* keyring.generate()
      const acct1 = yield* keyring.addAccount("aptos")
      const acct0 = yield* keyring.getKey("aptos")

      harness.seed(acct0.address, USDC, 10_000_000n)
      harness.seed(acct1.address, USDC, 20_000_000n)

      const allKeys = yield* keyring.listKeys()
      return yield* balance.getPortfolio(allKeys)
    })
    const portfolio = await Effect.runPromise(
      Effect.provide(program, harness.layer),
    )
    const usdcBalances = portfolio.balances.filter(
      (b) => b.asset.symbol === "USDC" && b.asset.chain === "aptos",
    )
    expect(usdcBalances).toHaveLength(2)
    const total = usdcBalances.reduce((s, b) => s + b.balance, 0n)
    expect(total).toBe(30_000_000n)
  })

  it("addAccount fails when no mnemonic is stored", async () => {
    const { layer } = makeTestHarness()
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      // Don't call generate — go straight to addAccount.
      return yield* keyring.addAccount("aptos")
    })
    const result = await Effect.runPromise(
      Effect.either(Effect.provide(program, layer)),
    )
    expect(result._tag).toBe("Left")
  })

  it("exportEncrypted / importEncrypted preserves multi-account keys", async () => {
    const { layer } = makeTestHarness()
    const encKey = new Uint8Array(32).fill(0xaa)
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      yield* keyring.generate()
      const acct1 = yield* keyring.addAccount("solana")
      const bundle = yield* keyring.exportEncrypted(encKey)
      const restored = yield* keyring.importEncrypted(bundle, encKey)
      return { acct1, restored }
    })
    const { acct1, restored } = await Effect.runPromise(
      Effect.provide(program, layer),
    )
    const solanaKeys = restored.filter((k) => k.chain === "solana")
    expect(solanaKeys).toHaveLength(2)
    expect(solanaKeys.find((k) => k.address === acct1.address)).toBeDefined()
  })
})
