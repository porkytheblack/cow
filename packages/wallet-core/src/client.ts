import { Effect, ManagedRuntime } from "effect"
import type { AssetId } from "./model/asset.js"
import type { Portfolio, TokenBalance } from "./model/balance.js"
import type { ChainId } from "./model/chain.js"
import type { DerivedKey, Mnemonic } from "./model/keyring.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "./model/transaction.js"
import type { TransferIntent, TransferPlan } from "./model/transfer.js"
import type { WalletConfig, WalletConfigInput } from "./config/index.js"
import { resolveConfig } from "./config/index.js"
import { USDC_ASSETS } from "./config/defaults.js"
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

  // --- Utilities -------------------------------------------------------

  /**
   * Look up a well-known asset by symbol and chain from the built-in
   * defaults (USDC on major chains). Returns undefined if not found.
   */
  asset(symbol: string, chain: ChainId): AssetId | undefined

  /**
   * Parse a human-readable amount into the smallest-unit bigint.
   * `parseUnits("10.5", 6)` -> `10_500_000n`
   */
  parseUnits(amount: string, decimals: number): bigint

  /**
   * Format a smallest-unit bigint into a human-readable string.
   * `formatUnits(10_500_000n, 6)` -> `"10.5"`
   */
  formatUnits(amount: bigint, decimals: number): string

  /**
   * Tear down the managed runtime, releasing any resources held by
   * the Layer (storage refs, adapter state). Call this in tests or
   * when the wallet instance is no longer needed.
   */
  dispose(): Promise<void>

  // --- Escape hatch ---------------------------------------------------

  /**
   * The underlying Effect Layer for callers who want to compose
   * services directly, override adapters, or run effects in a
   * test harness.
   */
  readonly layer: WalletLayer
}

/**
 * Build a promise-based `WalletClient`. Accepts either a full
 * `WalletConfig` or a minimal `WalletConfigInput` (only `chains` is
 * required — `cctp`, `auth`, `keyring` get sensible defaults).
 *
 * ```ts
 * // Minimal — just chains:
 * const wallet = createWalletClient({
 *   chains: [{ chainId: "evm:1", kind: "evm", name: "Ethereum", rpcUrl: "...", nativeAsset: { ... } }],
 * })
 *
 * // Full control:
 * const wallet = createWalletClient(fullConfig, { storage: mySecureStore, authGate: myAuthGate })
 * ```
 */
export const createWalletClient = (
  configInput: WalletConfig | WalletConfigInput,
  overrides?: WalletAdapterOverrides,
): WalletClient => {
  const config = resolveConfig(configInput as WalletConfigInput)

  // Warn on dangerous defaults that should never ship to production.
  if (!overrides?.storage) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cow] No storage adapter provided — using in-memory storage. Keys will be lost on page refresh. Pass a storage override for production.",
    )
  }
  if (!overrides?.authGate) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cow] No auth gate provided — using auto-approve (TestAuthGate). Every transaction will be signed without user confirmation. Pass an authGate override for production.",
    )
  }

  const walletLayer = createWallet(config, overrides)
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

    // --- Utilities -------------------------------------------------------

    asset: (symbol, chain) => {
      if (symbol.toUpperCase() === "USDC") {
        return (USDC_ASSETS as Partial<Record<string, AssetId>>)[
          chain as string
        ]
      }
      return undefined
    },

    parseUnits: (amount, decimals) => {
      const [whole = "0", frac = ""] = amount.split(".")
      const padded = frac.padEnd(decimals, "0").slice(0, decimals)
      return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded)
    },

    formatUnits: (amount, decimals) => {
      const s = amount.toString().padStart(decimals + 1, "0")
      const whole = s.slice(0, s.length - decimals)
      const frac = s.slice(s.length - decimals).replace(/0+$/, "")
      return frac ? `${whole}.${frac}` : whole
    },

    dispose: () => runtime.dispose(),
  }
}
