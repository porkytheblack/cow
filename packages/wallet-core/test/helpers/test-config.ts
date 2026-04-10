import type { ChainConfig } from "../../src/model/chain.js"
import type { WalletConfig } from "../../src/config/index.js"
import { DEFAULT_DERIVATION_PATHS } from "../../src/config/defaults.js"

const aptosChain: ChainConfig = {
  chainId: "aptos",
  name: "Aptos Mock",
  rpcUrl: "mock://aptos",
  kind: "mock",
  cctpDomain: 9,
  nativeAsset: {
    chain: "aptos",
    type: "native",
    symbol: "APT",
    decimals: 8,
  },
}

const solanaChain: ChainConfig = {
  chainId: "solana",
  name: "Solana Mock",
  rpcUrl: "mock://solana",
  kind: "mock",
  cctpDomain: 5,
  nativeAsset: {
    chain: "solana",
    type: "native",
    symbol: "SOL",
    decimals: 9,
  },
}

const evmChain: ChainConfig = {
  chainId: "evm:1",
  name: "Ethereum Mock",
  rpcUrl: "mock://evm",
  kind: "mock",
  cctpDomain: 0,
  nativeAsset: {
    chain: "evm:1",
    type: "native",
    symbol: "ETH",
    decimals: 18,
  },
}

export const testConfig: WalletConfig = {
  chains: [aptosChain, solanaChain, evmChain],
  cctp: {
    attestationApiUrl: "https://mock-iris.circle.test/v2",
    contractAddresses: {
      "evm:1": {
        tokenMessenger: "0x0000000000000000000000000000000000000001",
        messageTransmitter: "0x0000000000000000000000000000000000000002",
        usdcToken: "0x0000000000000000000000000000000000000003",
      },
    },
    attestationPollIntervalMs: 10,
    attestationTimeoutMs: 2_000,
  },
  auth: {
    elevatedThreshold: 100_000_000n,
    sessionTtlMs: 60_000,
    pinMinLength: 4,
  },
  keyring: {
    mnemonicStrength: 128,
    derivationPaths: {
      aptos: DEFAULT_DERIVATION_PATHS["aptos"]!,
      solana: DEFAULT_DERIVATION_PATHS["solana"]!,
      "evm:1": DEFAULT_DERIVATION_PATHS["evm:1"]!,
    },
  },
}
