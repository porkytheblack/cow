// Public API barrel for @wallet/core.

// Models
export * from "./model/index.js"

// Config
export {
  WalletConfigService,
  makeWalletConfigLayer,
  type WalletConfig,
  type CctpConfig,
  type AuthConfig,
  type KeyringConfig,
} from "./config/index.js"
export {
  DEFAULT_DERIVATION_PATHS,
  CCTP_DOMAINS,
  USDC_ASSETS,
  DEFAULT_CCTP_POLL_INTERVAL_MS,
  DEFAULT_CCTP_TIMEOUT_MS,
} from "./config/defaults.js"

// Adapter tags
export { FetchAdapter, type FetchRequest, type FetchResponse } from "./adapters/fetch/index.js"
export { BrowserFetchAdapter } from "./adapters/fetch/browser.js"
export { makeMockFetchAdapter } from "./adapters/fetch/mock.js"

export { StorageAdapter } from "./adapters/storage/index.js"
export { InMemoryStorageAdapter } from "./adapters/storage/memory.js"

export { BackupAdapter, type BackupManifest } from "./adapters/backup/index.js"
export { InMemoryBackupAdapter } from "./adapters/backup/memory.js"
export {
  FileExportBackupAdapter,
  FileExportBackupAdapterFromFile,
  packBackupFile,
  unpackBackupFile,
} from "./adapters/backup/file-export.js"
export {
  makeBridgedBackupAdapter,
  iCloudBackupAdapter,
  googleDriveBackupAdapter,
  type BridgedBackupHooks,
} from "./adapters/backup/bridged.js"

export {
  ChainAdapterRegistry,
  type ChainAdapter,
  type BuildTransferParams,
} from "./adapters/chain/index.js"
export {
  ChainAdapterRegistryLive,
  makeChainAdapterRegistryLayer,
  makeAptosAwareRegistryLive,
} from "./adapters/chain/registry.js"
export {
  makeMockChainAdapter,
  makeMockChainAdapterWithState,
} from "./adapters/chain/mock.js"
export { makeEvmChainAdapter, buildEvmCctpBurnTx } from "./adapters/chain/evm.js"
export { makeSolanaChainAdapter } from "./adapters/chain/solana.js"
export { makeAptosChainAdapter } from "./adapters/chain/aptos.js"
export { jsonRpcCall } from "./adapters/chain/json-rpc.js"

// Services
export { AuthGateService, TestAuthGate, DenyingAuthGate } from "./services/auth-gate.js"
export {
  makeCallbackAuthGate,
  deriveEncryptionKeyFromSecret,
  type CallbackAuthGateHooks,
} from "./services/auth-gate-callback.js"
export {
  makeWebAuthnAuthGate,
  type WebAuthnAuthGateOptions,
} from "./services/auth-gate-webauthn.js"
export { base58Encode, base58Decode } from "./services/keyring-crypto.js"
export { KeyringService, KeyringServiceLive } from "./services/keyring.js"
export { SignerService, SignerServiceLive } from "./services/signer.js"
export { BroadcastService, BroadcastServiceLive } from "./services/broadcast.js"
export { BalanceService, BalanceServiceLive } from "./services/balance.js"
export { RouterService, RouterServiceLive } from "./services/router.js"
export { CctpService, CctpServiceLive, pollCircleAttestation } from "./services/cctp.js"
export {
  TransferService,
  TransferServiceLive,
  type TransferResult,
  type CompletedStep,
} from "./services/transfer.js"

// Factory
export { createWallet, type WalletAdapterOverrides, type WalletLayer } from "./create-wallet.js"
