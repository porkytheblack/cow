import type { AssetId } from "../model/asset.js"
import type { ChainId } from "../model/chain.js"

/**
 * Default BIP-44 derivation paths for supported chains.
 * Aptos uses ed25519, Solana uses ed25519, EVM uses secp256k1.
 */
export const DEFAULT_DERIVATION_PATHS: Partial<Record<ChainId, string>> = {
  aptos: "m/44'/637'/0'/0'/0'",
  solana: "m/44'/501'/0'/0'",
  "evm:1": "m/44'/60'/0'/0/0",
  "evm:8453": "m/44'/60'/0'/0/0",
  "evm:42161": "m/44'/60'/0'/0/0",
  "evm:11155111": "m/44'/60'/0'/0/0",
}

/**
 * Circle CCTP V2 domain identifiers. These are used in burn messages
 * to identify the source/destination chain.
 *
 * NOTE: Sepolia has the same domain id as Ethereum mainnet (0) but is
 * only used against the Circle *sandbox* attestation API. Never
 * configure a wallet with both `evm:1` and `evm:11155111` in the same
 * `WalletConfig.chains` — the domain collision would cause mint
 * messages to resolve to whichever chain was registered first in the
 * adapter map.
 */
export const CCTP_DOMAINS: Partial<Record<ChainId, number>> = {
  "evm:1": 0,         // Ethereum
  "evm:43114": 1,     // Avalanche
  "evm:10": 2,        // Optimism
  "evm:42161": 3,     // Arbitrum
  solana: 5,          // Solana
  "evm:8453": 6,      // Base
  aptos: 9,           // Aptos
  "evm:11155111": 0,  // Sepolia (sandbox only — see note above)
}

/**
 * Well-known USDC asset descriptors. Contract addresses are left to per-chain
 * config — this is symbolic identity only.
 */
export const USDC_ASSETS: Partial<Record<ChainId, AssetId>> = {
  aptos: {
    chain: "aptos",
    type: "token",
    symbol: "USDC",
    decimals: 6,
    address: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
  },
  solana: {
    chain: "solana",
    type: "token",
    symbol: "USDC",
    decimals: 6,
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  "evm:1": {
    chain: "evm:1",
    type: "token",
    symbol: "USDC",
    decimals: 6,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
}

export const DEFAULT_CCTP_POLL_INTERVAL_MS = 2_000
export const DEFAULT_CCTP_TIMEOUT_MS = 30 * 60_000

/**
 * Default CCTP version per chain. Aptos is V1; all EVM chains are V2.
 * Consumers can override per-chain via
 * `WalletConfig.cctp.contractAddresses[chainId].version`.
 */
export const CCTP_VERSIONS: Partial<Record<ChainId, "v1" | "v2">> = {
  "evm:1": "v2",
  "evm:43114": "v2",
  "evm:10": "v2",
  "evm:42161": "v2",
  "evm:8453": "v2",
  "evm:11155111": "v2",
  solana: "v1",
  aptos: "v1",
}
