import { Context, Effect, Layer } from "effect"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import type { AssetId } from "../model/asset.js"
import type { Portfolio, TokenBalance } from "../model/balance.js"
import type { ChainId } from "../model/chain.js"
import type { DerivedKey } from "../model/keyring.js"
import { UnsupportedChainError } from "../model/errors.js"

export interface BalanceServiceShape {
  readonly getBalance: (
    chain: ChainId,
    address: string,
    asset: AssetId,
  ) => Effect.Effect<TokenBalance, UnsupportedChainError, ChainAdapterRegistry>

  readonly getPortfolio: (
    keys: readonly DerivedKey[],
  ) => Effect.Effect<Portfolio, UnsupportedChainError, ChainAdapterRegistry>
}

export class BalanceService extends Context.Tag("BalanceService")<
  BalanceService,
  BalanceServiceShape
>() {}

export const BalanceServiceLive = Layer.succeed(BalanceService, {
  getBalance: (chain, address, asset) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(chain)
      const balance = yield* adapter.getBalance(address, asset)
      const result: TokenBalance = { asset, balance, address }
      return result
    }),

  getPortfolio: (keys) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const results = yield* Effect.all(
        keys.map((key) =>
          Effect.gen(function* () {
            const adapter = yield* registry.get(key.chain)
            return yield* adapter.getAllBalances(key.address)
          }),
        ),
        { concurrency: "unbounded" },
      )
      const flat: TokenBalance[] = []
      for (const list of results) flat.push(...list)
      const portfolio: Portfolio = { balances: flat }
      return portfolio
    }),
})
