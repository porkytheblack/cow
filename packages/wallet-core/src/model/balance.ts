import type { AssetId } from "./asset.js"

export interface TokenBalance {
  readonly asset: AssetId
  readonly balance: bigint
  readonly address: string
}

export interface Portfolio {
  readonly balances: readonly TokenBalance[]
  readonly totalUsdValue?: number
}
