import { Layer } from "effect"
import { BackupAdapter } from "./adapters/backup/index.js"
import { InMemoryBackupAdapter } from "./adapters/backup/memory.js"
import { ChainAdapterRegistry } from "./adapters/chain/index.js"
import { ChainAdapterRegistryLive } from "./adapters/chain/registry.js"
import { BrowserFetchAdapter } from "./adapters/fetch/browser.js"
import { FetchAdapter } from "./adapters/fetch/index.js"
import { StorageAdapter } from "./adapters/storage/index.js"
import { InMemoryStorageAdapter } from "./adapters/storage/memory.js"
import { makeWalletConfigLayer, resolveConfig, WalletConfigService } from "./config/index.js"
import type { WalletConfig, WalletConfigInput } from "./config/index.js"
import { AuthGateService, TestAuthGate } from "./services/auth-gate.js"
import { BalanceService, BalanceServiceLive } from "./services/balance.js"
import { BroadcastService, BroadcastServiceLive } from "./services/broadcast.js"
import { CctpService, CctpServiceLive } from "./services/cctp.js"
import { KeyringService, KeyringServiceLive } from "./services/keyring.js"
import { RouterService, RouterServiceLive } from "./services/router.js"
import { SignerService, SignerServiceLive } from "./services/signer.js"
import { TransferService, TransferServiceLive } from "./services/transfer.js"

export interface WalletAdapterOverrides {
  readonly storage?: Layer.Layer<StorageAdapter>
  readonly backup?: Layer.Layer<BackupAdapter>
  readonly authGate?: Layer.Layer<AuthGateService>
  readonly fetch?: Layer.Layer<FetchAdapter>
  /**
   * Override the chain-adapter registry wholesale. Useful in tests that
   * need to pre-seed mock adapter balances before the wallet is built.
   */
  readonly chainRegistry?: Layer.Layer<ChainAdapterRegistry, never, WalletConfigService | FetchAdapter>
}

export type WalletLayer = Layer.Layer<
  | TransferService
  | BalanceService
  | BroadcastService
  | RouterService
  | CctpService
  | SignerService
  | KeyringService
  | AuthGateService
  | ChainAdapterRegistry
  | BackupAdapter
  | StorageAdapter
  | FetchAdapter
  | WalletConfigService
>

/**
 * Top-level factory. Takes a `WalletConfig` plus any adapter overrides
 * and produces a fully-wired Effect Layer that provides every wallet-core
 * service. No hidden state — every dependency is explicit.
 *
 * Defaults:
 *   storage     -> InMemoryStorageAdapter
 *   backup      -> InMemoryBackupAdapter
 *   authGate    -> TestAuthGate (auto-approves — switch for production)
 *   fetch       -> BrowserFetchAdapter (globalThis.fetch)
 *   chainRegistry -> ChainAdapterRegistryLive (reads config.chains)
 */
export const createWallet = (
  configInput: WalletConfig | WalletConfigInput,
  overrides?: WalletAdapterOverrides,
): WalletLayer => {
  const config = resolveConfig(configInput as WalletConfigInput)
  const configLayer = makeWalletConfigLayer(config)
  const fetchLayer = overrides?.fetch ?? BrowserFetchAdapter
  const storageLayer = overrides?.storage ?? InMemoryStorageAdapter
  const backupLayer = overrides?.backup ?? InMemoryBackupAdapter
  const authLayer = overrides?.authGate ?? TestAuthGate
  const chainRegistryLayer = overrides?.chainRegistry ?? ChainAdapterRegistryLive

  // Base adapter layer: everything that has no service-level dependencies
  // other than config/fetch.
  const baseAdapters = Layer.mergeAll(
    configLayer,
    fetchLayer,
    storageLayer,
    backupLayer,
    authLayer,
  )

  // Chain registry depends on config + fetch, both already in baseAdapters.
  const chainRegistry = chainRegistryLayer.pipe(Layer.provide(baseAdapters))

  // Service layers. Each is defined via Layer.succeed over a shape whose
  // methods yield from other services — composition is handled by
  // Layer.provideMerge at the very end.
  const serviceLayers = Layer.mergeAll(
    KeyringServiceLive,
    SignerServiceLive,
    BroadcastServiceLive,
    BalanceServiceLive,
    RouterServiceLive,
    CctpServiceLive,
    TransferServiceLive,
  )

  return Layer.mergeAll(
    baseAdapters,
    chainRegistry,
    serviceLayers,
  ) as WalletLayer
}
