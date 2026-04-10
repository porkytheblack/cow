import type { AssetId } from "./asset.js"

/**
 * Chain identifier. Well-known values: "aptos", "solana", "evm:<chainId>"
 * The `(string & {})` trick keeps known literals in autocomplete while
 * permitting user-defined chains.
 */
export type ChainId = "aptos" | "solana" | `evm:${string}` | (string & {})

export interface ChainAddress {
  readonly chain: ChainId
  readonly address: string
}

/**
 * Per-chain configuration. Open-ended — consumers can thread custom keys
 * (indexer URLs, explorer URLs, etc.) via the index signature.
 */
export interface ChainConfig {
  readonly chainId: ChainId
  readonly name: string
  readonly rpcUrl: string
  readonly nativeAsset: AssetId
  /** Circle CCTP domain identifier, if supported on this chain */
  readonly cctpDomain?: number
  /** Chain kind — drives which ChainAdapter implementation is selected */
  readonly kind: "aptos" | "solana" | "evm" | "mock"
  readonly [key: string]: unknown
}
