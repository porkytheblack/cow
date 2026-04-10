import type { ChainId } from "./chain.js"

export interface AssetId {
  readonly chain: ChainId
  readonly type: "native" | "token"
  /** Token contract / mint / coin type address. Omitted for native assets. */
  readonly address?: string
  readonly symbol: string
  readonly decimals: number
}

/**
 * Compare two AssetIds for equality.
 */
export const assetIdEquals = (a: AssetId, b: AssetId): boolean =>
  a.chain === b.chain &&
  a.type === b.type &&
  a.symbol === b.symbol &&
  a.decimals === b.decimals &&
  (a.address ?? "") === (b.address ?? "")

/**
 * Determine whether an asset is USDC by symbol. Chain-specific address
 * checks live in each ChainAdapter.
 */
export const isUsdc = (asset: AssetId): boolean =>
  asset.symbol.toUpperCase() === "USDC"
