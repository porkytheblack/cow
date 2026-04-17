import { Effect, ManagedRuntime } from "effect"
import type { AssetId } from "./model/asset.js"
import type { Portfolio, TokenBalance } from "./model/balance.js"
import type { ChainId } from "./model/chain.js"
import type { DerivedKey, Mnemonic } from "./model/keyring.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "./model/transaction.js"
import type { TransferIntent, TransferPlan } from "./model/transfer.js"
import type { WalletConfig } from "./config/index.js"
import { createWallet, type WalletAdapterOverrides, type WalletLayer } from "./create-wallet.js"
import { KeyringService } from "./services/keyring.js"
import { SignerService } from "./services/signer.js"
import { BroadcastService } from "./services/broadcast.js"
import { BalanceService } from "./services/balance.js"
import { RouterService } from "./services/router.js"
import { CctpService, type ResumeResult } from "./services/cctp.js"
import { TransferService, type TransferResult } from "./services/transfer.js"
import { AuthGateService } from "./services/auth-gate.js"

/**
 * Promise-based wallet client. Wraps every Effect service method
 * behind a plain `async` function so consumers never touch `Effect`,
 * `Layer`, or `yield*`.
 *
 * ```ts
 * const wallet = createWalletClient(config)
 *
 * const { mnemonic, keys } = await wallet.generate()
 * const balance = await wallet.getBalance("evm:1", keys[0].address, usdc)
 * const result  = await wallet.transfer({ from, to, asset, amount })
 * ```
 *
 * Errors are thrown as-is — they're plain objects with a `_tag` field
 * (`"InsufficientBalanceError"`, `"AuthDeniedError"`, etc.) so
 * callers can pattern-match in a `catch` block without importing
 * Effect:
 *
 * ```ts
 * try {
 *   await wallet.transfer(intent)
 * } catch (e: any) {
 *   if (e._tag === "InsufficientBalanceError") { ... }
 * }
 * ```
 *
 * For callers who want the full Effect layer (custom composition,
 * test overrides, streaming), `wallet.layer` exposes the underlying
 * `WalletLayer` directly.
 */
export interface WalletClient {
  // --- Keyring --------------------------------------------------------

  generate(): Promise<{ mnemonic: Mnemonic; keys: readonly DerivedKey[] }>
  importMnemonic(phrase: string): Promise<readonly DerivedKey[]>
  importPrivateKey(
    chain: ChainId,
    privateKey: Uint8Array,
    options?: { overwrite?: boolean; accountIndex?: number },
  ): Promise<DerivedKey>
  addAccount(chain: ChainId): Promise<DerivedKey>
  getKey(chain: ChainId, address?: string): Promise<DerivedKey>
  listKeys(): Promise<readonly DerivedKey[]>

  // --- Balances -------------------------------------------------------

  getBalance(
    chain: ChainId,
    address: string,
    asset: AssetId,
  ): Promise<TokenBalance>

  /**
   * Fetch balances for the supplied keys. When called with no
   * arguments, automatically lists every stored key and queries all
   * accounts on all chains.
   */
  getPortfolio(keys?: readonly DerivedKey[]): Promise<Portfolio>

  // --- Transfers ------------------------------------------------------

  transfer(intent: TransferIntent): Promise<TransferResult>
  planTransfer(intent: TransferIntent): Promise<TransferPlan>

  // --- Signing (lower-level) ------------------------------------------

  sign(tx: UnsignedTx): Promise<SignedTx>
  broadcast(signed: SignedTx): Promise<TxReceipt>

  // --- CCTP -----------------------------------------------------------

  resumeCctpTransfer(
    id: string,
    recipient: string,
    destChain: ChainId,
  ): Promise<ResumeResult>

  // --- Backup ---------------------------------------------------------

  exportBackup(encryptionKey: Uint8Array): Promise<Uint8Array>
  importBackup(
    bundle: Uint8Array,
    encryptionKey: Uint8Array,
  ): Promise<readonly DerivedKey[]>
  deriveEncryptionKey(): Promise<Uint8Array>

  // --- Escape hatch ---------------------------------------------------

  /**
   * The underlying Effect Layer for callers who want to compose
   * services directly, override adapters, or run effects in a
   * test harness.
   */
  readonly layer: WalletLayer
}

/**
 * Build a promise-based `WalletClient` from a `WalletConfig` (and
 * optional adapter overrides). This is the main entry point for
 * consumers who don't use Effect TS.
 *
 * Internally it calls `createWallet(config, overrides)` to produce a
 * fully-wired `Layer`, then creates a `ManagedRuntime` that keeps
 * Layer state (storage Refs, adapter instances) alive across method
 * calls. Every public method just runs `Effect.runPromise` on that
 * shared runtime.
 */
export const createWalletClient = (
  config: WalletConfig,
  overrides?: WalletAdapterOverrides,
): WalletClient => {
  const walletLayer = createWallet(config, overrides)

  // ManagedRuntime builds the layer once and caches it — Refs inside
  // InMemoryStorageAdapter (and any other stateful layers) persist
  // across calls. Without this, each runPromise would get a fresh
  // layer build and lose stored keys/balances/state.
  const runtime = ManagedRuntime.make(walletLayer)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = <A>(effect: Effect.Effect<A, any, any>): Promise<A> =>
    runtime.runPromise(effect)

  return {
    layer: walletLayer,

    // --- Keyring ------------------------------------------------------

    generate: () =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.generate()
        }),
      ),

    importMnemonic: (phrase) =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.importMnemonic(phrase)
        }),
      ),

    importPrivateKey: (chain, privateKey, options) =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.importPrivateKey(chain, privateKey, options)
        }),
      ),

    addAccount: (chain) =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.addAccount(chain)
        }),
      ),

    getKey: (chain, address) =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.getKey(chain, address)
        }),
      ),

    listKeys: () =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.listKeys()
        }),
      ),

    // --- Balances ------------------------------------------------------

    getBalance: (chain, address, asset) =>
      run(
        Effect.gen(function* () {
          const balance = yield* BalanceService
          return yield* balance.getBalance(chain, address, asset)
        }),
      ),

    getPortfolio: (keys) =>
      run(
        Effect.gen(function* () {
          const balance = yield* BalanceService
          let allKeys = keys
          if (!allKeys) {
            const keyring = yield* KeyringService
            allKeys = yield* keyring.listKeys()
          }
          return yield* balance.getPortfolio(allKeys)
        }),
      ),

    // --- Transfers -----------------------------------------------------

    transfer: (intent) =>
      run(
        Effect.gen(function* () {
          const svc = yield* TransferService
          return yield* svc.execute(intent)
        }),
      ),

    planTransfer: (intent) =>
      run(
        Effect.gen(function* () {
          const router = yield* RouterService
          return yield* router.plan(intent)
        }),
      ),

    // --- Signing -------------------------------------------------------

    sign: (tx) =>
      run(
        Effect.gen(function* () {
          const signer = yield* SignerService
          return yield* signer.sign(tx)
        }),
      ),

    broadcast: (signed) =>
      run(
        Effect.gen(function* () {
          const svc = yield* BroadcastService
          return yield* svc.submit(signed)
        }),
      ),

    // --- CCTP ----------------------------------------------------------

    resumeCctpTransfer: (id, recipient, destChain) =>
      run(
        Effect.gen(function* () {
          const cctp = yield* CctpService
          return yield* cctp.resumePending(id, recipient, destChain)
        }),
      ),

    // --- Backup --------------------------------------------------------

    exportBackup: (encryptionKey) =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.exportEncrypted(encryptionKey)
        }),
      ),

    importBackup: (bundle, encryptionKey) =>
      run(
        Effect.gen(function* () {
          const keyring = yield* KeyringService
          return yield* keyring.importEncrypted(bundle, encryptionKey)
        }),
      ),

    deriveEncryptionKey: () =>
      run(
        Effect.gen(function* () {
          const auth = yield* AuthGateService
          return yield* auth.deriveEncryptionKey()
        }),
      ),
  }
}
