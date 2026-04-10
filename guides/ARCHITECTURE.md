# Multichain Wallet — Effect TS Service Architecture

## Overview

A multichain wallet library built entirely on Effect TS. All services are testable in isolation via Effect's Layer system — no app shell, no UI, no React Native required. The library produces pure Effect programs that can be exercised from Vitest today and embedded in a mobile app later.

Supported chains: **Aptos · Solana · EVM** (any EVM chain)
Cross-chain: **CCTP V2** (Circle)

### Frontend Environment Constraints

This library runs in browsers and React Native. **Zero Node.js APIs.**

- **No** `fs`, `path`, `crypto`, `Buffer`, `process`, `http`/`https`
- Use `Uint8Array` everywhere — never `Buffer`
- Use `globalThis.crypto` (Web Crypto API) for randomness and HKDF
- Use `fetch` via injected `FetchAdapter` for all HTTP — no `axios`, no `node-fetch`
- All `@noble/*` and `@scure/*` packages are pure JS, no native deps — safe
- `viem`, `@solana/web3.js` v2, `@aptos-labs/ts-sdk` are all browser-native
- WASM allowed (some crypto libs ship optional WASM acceleration)
- Package `"type": "module"`, target `ES2022`, `"sideEffects": false` for tree-shaking

---

## 1. Project Structure

```
packages/
  wallet-core/
    src/
      adapters/
        chain/
          aptos.ts          # AptosChainAdapter
          solana.ts          # SolanaChainAdapter
          evm.ts             # EvmChainAdapter
          index.ts           # ChainAdapter tag + union type
        storage/
          memory.ts          # InMemoryStorageAdapter (testing)
          secure-store.ts    # React Native SecureStore (prod)
          index.ts           # StorageAdapter tag
        backup/
          memory.ts          # InMemoryBackupAdapter (testing)
          icloud.ts          # iCloud KV adapter
          google-drive.ts    # Google Drive adapter
          file-export.ts     # Manual encrypted file export
          index.ts           # BackupAdapter tag
      services/
        keyring.ts           # KeyringService — key generation & storage
        auth-gate.ts         # AuthGateService — passkey/PIN approval
        signer.ts            # SignerService — sign transactions
        balance.ts           # BalanceService — cross-chain balances
        broadcast.ts         # BroadcastService — submit signed txs
        router.ts            # RouterService — transfer intent decomposition
        cctp.ts              # CctpService — burn/attest/mint lifecycle
        transfer.ts          # TransferService — top-level orchestrator
      adapters/
        fetch/
          browser.ts         # BrowserFetchAdapter (uses globalThis.fetch)
          custom.ts          # Lets consumer pass any fetch-like function
          index.ts           # FetchAdapter tag
      config/
        index.ts             # WalletConfig type + WalletConfigService tag
        defaults.ts          # sensible defaults, CCTP addresses, known assets
      model/
        chain.ts             # Chain, ChainId, ChainAddress
        asset.ts             # AssetId, AssetMetadata, NativeAsset, USDC
        transaction.ts       # UnsignedTx, SignedTx, TxReceipt, TxHash
        transfer.ts          # TransferIntent, TransferPlan, TransferStep
        keyring.ts           # Keypair, DerivedKey, Mnemonic, DerivationPath
        auth.ts              # AuthMethod, AuthApproval, AuthDenied
        balance.ts           # TokenBalance, Portfolio
        cctp.ts              # BurnMessage, Attestation, MintParams, PendingCctpTransfer
        errors.ts            # All typed errors (see §9)
      create-wallet.ts       # Top-level factory: config → fully wired Layer
      index.ts               # Public API barrel
    test/
      helpers/
        test-layers.ts       # Prebuilt Layer compositions for tests
      keyring.test.ts
      signer.test.ts
      balance.test.ts
      broadcast.test.ts
      router.test.ts
      cctp.test.ts
      transfer.test.ts       # Full integration with in-memory adapters
    vitest.config.ts
    tsconfig.json
    package.json
```

---

## 2. Core Models

### 2.1 Chain

```typescript
// model/chain.ts
import { Data } from "effect"

type ChainId = "aptos" | "solana" | "evm:1" | "evm:8453" | "evm:42161" | (string & {})

interface ChainAddress {
  readonly chain: ChainId
  readonly address: string
}

// Type-safe chain config
interface ChainConfig {
  readonly chainId: ChainId
  readonly name: string
  readonly rpcUrl: string
  readonly nativeAsset: AssetId
  readonly cctpDomain?: number  // Circle CCTP domain identifier
  readonly [key: string]: unknown  // open for chain-specific extras (e.g. Aptos indexer URL)
}
```

### 2.1b WalletConfig

The root configuration object. Fully consumer-provided — no hidden defaults the caller can't override. All service layers read from this via `WalletConfigService`.

```typescript
// config/index.ts
import { Context, Effect } from "effect"

interface WalletConfig {
  // --- Chains ---
  readonly chains: readonly ChainConfig[]

  // --- CCTP ---
  readonly cctp: {
    readonly attestationApiUrl: string  // "https://iris-api.circle.com/v2"
    readonly contractAddresses: Record<ChainId, {
      readonly tokenMessenger: string
      readonly messageTransmitter: string
      readonly usdcToken: string
    }>
    readonly attestationPollIntervalMs: number  // default 2000
    readonly attestationTimeoutMs: number       // default 1800000 (30min)
  }

  // --- Auth ---
  readonly auth: {
    readonly elevatedThreshold: bigint     // tx value above this requires passkey
    readonly sessionTtlMs: number          // how long a single approval session lasts
    readonly pinMinLength: number
  }

  // --- Keyring ---
  readonly keyring: {
    readonly mnemonicStrength: 128 | 256   // 12 or 24 words
    readonly derivationPaths: Record<ChainId, string>
    // consumer can override or add paths for custom chains
  }

  // --- Open extension ---
  readonly [key: string]: unknown
  // Consumers can thread any app-specific config (analytics keys,
  // feature flags, timeout overrides) without forking the library.
}

// Effect service tag — every service that needs config depends on this
class WalletConfigService extends Context.Tag("WalletConfigService")<
  WalletConfigService,
  {
    readonly config: WalletConfig
    readonly get: <K extends keyof WalletConfig>(key: K) => WalletConfig[K]
    readonly getChain: (chainId: ChainId) => Effect.Effect<ChainConfig, UnsupportedChainError>
  }
>() {}
```

### 2.1c FetchAdapter

All HTTP goes through this — chain RPCs, Circle attestation API, anything else. Never call `fetch` directly.

```typescript
// adapters/fetch/index.ts
import { Context, Effect } from "effect"

interface FetchRequest {
  readonly url: string
  readonly method: "GET" | "POST"
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array
  readonly timeoutMs?: number
}

interface FetchResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Uint8Array
  readonly json: <T = unknown>() => Effect.Effect<T, FetchError>
  readonly text: () => Effect.Effect<string, FetchError>
}

class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string
  readonly status?: number
  readonly cause: unknown
}> {}

class FetchAdapter extends Context.Tag("FetchAdapter")<
  FetchAdapter,
  {
    readonly request: (req: FetchRequest) => Effect.Effect<FetchResponse, FetchError>
  }
>() {}

// Default: uses globalThis.fetch — works in browsers and React Native
// Consumer can replace with interceptors, logging, retry wrappers, auth headers, etc.
```

### 2.2 Asset

```typescript
// model/asset.ts
type AssetId = {
  readonly chain: ChainId
  readonly type: "native" | "token"
  readonly address?: string  // token contract/mint/type address
  readonly symbol: string
  readonly decimals: number
}

// Well-known assets
const USDC: Record<ChainId, AssetId> // one entry per supported chain
```

### 2.3 Transaction

```typescript
// model/transaction.ts
import { Data } from "effect"

interface UnsignedTx {
  readonly chain: ChainId
  readonly from: string
  readonly payload: unknown  // chain-native payload (AptosEntryFunction | SolanaTransaction | EvmTxRequest)
  readonly estimatedFee?: bigint
  readonly metadata: TxMetadata
}

interface TxMetadata {
  readonly intent: string        // human-readable label, e.g. "Transfer 10 USDC to 0x..."
  readonly createdAt: number     // epoch ms
  readonly transferId?: string   // links to TransferPlan if part of multi-step
}

interface SignedTx {
  readonly chain: ChainId
  readonly raw: Uint8Array       // serialised signed bytes, ready to broadcast
  readonly hash: string          // precomputed tx hash
  readonly unsigned: UnsignedTx  // reference back
}

interface TxReceipt {
  readonly chain: ChainId
  readonly hash: string
  readonly status: "confirmed" | "failed"
  readonly blockNumber?: bigint
  readonly fee?: bigint
  readonly raw?: unknown         // chain-native receipt
}
```

### 2.4 Transfer

```typescript
// model/transfer.ts

// What the user wants
interface TransferIntent {
  readonly from: ChainAddress
  readonly to: ChainAddress
  readonly asset: AssetId
  readonly amount: bigint
}

// What the router produces
interface TransferPlan {
  readonly id: string            // uuid
  readonly intent: TransferIntent
  readonly steps: readonly TransferStep[]
  readonly isCrossChain: boolean
}

type TransferStep =
  | { readonly type: "direct-transfer"; readonly chain: ChainId; readonly tx: UnsignedTx }
  | { readonly type: "cctp-burn";       readonly sourceChain: ChainId; readonly tx: UnsignedTx }
  | { readonly type: "cctp-mint";       readonly destChain: ChainId; /* built after attestation */ }
```

### 2.5 Keyring

```typescript
// model/keyring.ts

interface Mnemonic {
  readonly phrase: string      // 12 or 24 words
  readonly entropy: Uint8Array
}

interface DerivationPath {
  readonly chain: ChainId
  readonly path: string
  // BIP-44: m/44'/637'/0'/0'/0' (Aptos)
  // BIP-44: m/44'/501'/0'/0' (Solana)
  // BIP-44: m/44'/60'/0'/0/0 (EVM)
}

interface DerivedKey {
  readonly chain: ChainId
  readonly publicKey: Uint8Array
  readonly address: string
  readonly path: DerivationPath
}

// Private keys never leave KeyringService. This type is internal only.
interface StoredKeypair {
  readonly derivedKey: DerivedKey
  readonly encryptedPrivateKey: Uint8Array  // encrypted at rest via auth-derived key
  readonly nonce: Uint8Array
}
```

### 2.6 Auth

```typescript
// model/auth.ts

type AuthMethod = "passkey" | "pin" | "biometric"

interface AuthRequest {
  readonly reason: string       // "Sign transfer of 10 USDC to 0x..."
  readonly requiredLevel: "standard" | "elevated"
  // standard = PIN or biometric ok
  // elevated = passkey required (large sends, exports, backup)
}

interface AuthApproval {
  readonly method: AuthMethod
  readonly timestamp: number
  readonly sessionToken?: string  // optional short-lived session to batch rapid actions
}
```

### 2.7 CCTP

```typescript
// model/cctp.ts

interface BurnMessage {
  readonly sourceDomain: number
  readonly destDomain: number
  readonly nonce: bigint
  readonly burnTxHash: string
  readonly messageBytes: Uint8Array
  readonly messageHash: string
}

interface Attestation {
  readonly message: BurnMessage
  readonly attestation: string  // hex-encoded Circle attestation signature
}

type CctpTransferStatus =
  | "burning"
  | "awaiting-attestation"
  | "attested"
  | "minting"
  | "completed"
  | "failed"

interface PendingCctpTransfer {
  readonly id: string
  readonly planId: string
  readonly status: CctpTransferStatus
  readonly burn?: BurnMessage
  readonly attestation?: Attestation
  readonly mintTxHash?: string
  readonly createdAt: number
  readonly updatedAt: number
}
```

### 2.8 Errors

```typescript
// model/errors.ts
import { Data } from "effect"

class KeyGenerationError extends Data.TaggedError("KeyGenerationError")<{
  readonly message: string
}> {}

class KeyNotFoundError extends Data.TaggedError("KeyNotFoundError")<{
  readonly chain: ChainId
  readonly address: string
}> {}

class AuthDeniedError extends Data.TaggedError("AuthDeniedError")<{
  readonly reason: string
}> {}

class AuthTimeoutError extends Data.TaggedError("AuthTimeoutError")<{}> {}

class InsufficientBalanceError extends Data.TaggedError("InsufficientBalanceError")<{
  readonly chain: ChainId
  readonly required: bigint
  readonly available: bigint
}> {}

class BroadcastError extends Data.TaggedError("BroadcastError")<{
  readonly chain: ChainId
  readonly hash?: string
  readonly cause: unknown
}> {}

class FeeEstimationError extends Data.TaggedError("FeeEstimationError")<{
  readonly chain: ChainId
  readonly cause: unknown
}> {}

class CctpAttestationTimeout extends Data.TaggedError("CctpAttestationTimeout")<{
  readonly burnTxHash: string
  readonly elapsed: number
}> {}

class CctpMintError extends Data.TaggedError("CctpMintError")<{
  readonly destChain: ChainId
  readonly cause: unknown
}> {}

class UnsupportedChainError extends Data.TaggedError("UnsupportedChainError")<{
  readonly chain: string
}> {}

class UnsupportedRouteError extends Data.TaggedError("UnsupportedRouteError")<{
  readonly from: ChainId
  readonly to: ChainId
  readonly asset: string
}> {}

class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "read" | "write" | "delete"
  readonly key: string
  readonly cause: unknown
}> {}

class BackupError extends Data.TaggedError("BackupError")<{
  readonly provider: string
  readonly operation: "export" | "import"
  readonly cause: unknown
}> {}

class BackupDecryptionError extends Data.TaggedError("BackupDecryptionError")<{
  readonly message: string
}> {}

class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string
  readonly status?: number
  readonly cause: unknown
}> {}
```

---

## 3. Adapter Interfaces

All adapters are defined as Effect `Context.Tag` services so they can be swapped via Layers.

### 3.1 ChainAdapter

```typescript
// adapters/chain/index.ts
import { Context, Effect } from "effect"

interface ChainAdapter {
  readonly chainId: ChainId

  deriveAddress(publicKey: Uint8Array): Effect.Effect<string, UnsupportedChainError>

  buildTransferTx(params: {
    from: string
    to: string
    asset: AssetId
    amount: bigint
  }): Effect.Effect<UnsignedTx, FeeEstimationError | InsufficientBalanceError>

  buildRawTx(payload: unknown): Effect.Effect<UnsignedTx, FeeEstimationError>

  estimateFee(tx: UnsignedTx): Effect.Effect<bigint, FeeEstimationError>

  broadcast(signed: SignedTx): Effect.Effect<TxReceipt, BroadcastError>

  getBalance(address: string, asset: AssetId): Effect.Effect<bigint>

  getAllBalances(address: string): Effect.Effect<readonly TokenBalance[]>

  sign(tx: UnsignedTx, privateKey: Uint8Array): Effect.Effect<SignedTx>
}

// Registry of chain adapters, keyed by ChainId
// Built from WalletConfig.chains — each ChainConfig spawns the right adapter
class ChainAdapterRegistry extends Context.Tag("ChainAdapterRegistry")<
  ChainAdapterRegistry,
  {
    readonly get: (chainId: ChainId) => Effect.Effect<ChainAdapter, UnsupportedChainError>
    readonly supported: () => readonly ChainId[]
  }
>() {}

// Factory: reads WalletConfig, creates one adapter per configured chain
// Each adapter receives FetchAdapter for RPC calls — no direct fetch
const ChainAdapterRegistryLive = Layer.effect(
  ChainAdapterRegistry,
  Effect.gen(function* () {
    const { config } = yield* WalletConfigService
    const fetcher = yield* FetchAdapter
    // build adapter map from config.chains
    // Aptos config → AptosChainAdapter(chainConfig, fetcher)
    // Solana config → SolanaChainAdapter(chainConfig, fetcher)
    // evm:* config → EvmChainAdapter(chainConfig, fetcher)
  })
)
```

### 3.2 StorageAdapter

```typescript
// adapters/storage/index.ts
import { Context, Effect } from "effect"

class StorageAdapter extends Context.Tag("StorageAdapter")<
  StorageAdapter,
  {
    readonly save: (key: string, value: Uint8Array) => Effect.Effect<void, StorageError>
    readonly load: (key: string) => Effect.Effect<Uint8Array | null, StorageError>
    readonly delete: (key: string) => Effect.Effect<void, StorageError>
    readonly list: (prefix: string) => Effect.Effect<readonly string[], StorageError>
  }
>() {}
```

### 3.3 BackupAdapter

```typescript
// adapters/backup/index.ts
import { Context, Effect } from "effect"

interface BackupManifest {
  readonly version: number
  readonly createdAt: number
  readonly chains: readonly ChainId[]
  readonly addressCount: number
  readonly checksum: string
}

class BackupAdapter extends Context.Tag("BackupAdapter")<
  BackupAdapter,
  {
    // Export encrypted keyring bundle
    readonly exportBackup: (
      encryptedBundle: Uint8Array,
      manifest: BackupManifest
    ) => Effect.Effect<void, BackupError>

    // Import — returns the encrypted bundle, caller decrypts
    readonly importBackup: () => Effect.Effect<
      { bundle: Uint8Array; manifest: BackupManifest },
      BackupError | BackupDecryptionError
    >

    // Check if a backup exists
    readonly status: () => Effect.Effect<
      { exists: boolean; lastBackup?: number },
      BackupError
    >
  }
>() {}
```

---

## 4. Services

### 4.1 KeyringService

Owns all key material. Private keys never leave this service.

```typescript
// services/keyring.ts
import { Context, Effect } from "effect"

class KeyringService extends Context.Tag("KeyringService")<
  KeyringService,
  {
    // Generate a new mnemonic and derive keys for all supported chains
    readonly generate: () => Effect.Effect<
      { mnemonic: Mnemonic; keys: readonly DerivedKey[] },
      KeyGenerationError,
      StorageAdapter
    >

    // Import from existing mnemonic
    readonly importMnemonic: (phrase: string) => Effect.Effect<
      readonly DerivedKey[],
      KeyGenerationError,
      StorageAdapter
    >

    // Get derived key info (public only)
    readonly getKey: (chain: ChainId) => Effect.Effect<
      DerivedKey,
      KeyNotFoundError,
      StorageAdapter
    >

    // List all derived addresses
    readonly listKeys: () => Effect.Effect<
      readonly DerivedKey[],
      never,
      StorageAdapter
    >

    // Sign arbitrary bytes — INTERNAL, only called by SignerService
    readonly signBytes: (
      chain: ChainId,
      data: Uint8Array,
      authProof: AuthApproval
    ) => Effect.Effect<
      Uint8Array,
      KeyNotFoundError | AuthDeniedError,
      StorageAdapter
    >

    // Export encrypted backup bundle
    readonly exportEncrypted: (
      encryptionKey: Uint8Array
    ) => Effect.Effect<Uint8Array, StorageError, StorageAdapter>

    // Import from encrypted backup bundle
    readonly importEncrypted: (
      bundle: Uint8Array,
      encryptionKey: Uint8Array
    ) => Effect.Effect<readonly DerivedKey[], BackupDecryptionError | KeyGenerationError, StorageAdapter>
  }
>() {}
```

**Implementation notes:**
- Single BIP-39 mnemonic, chain-specific BIP-44 derivation paths
- Aptos: `m/44'/637'/0'/0'/0'` (ed25519)
- Solana: `m/44'/501'/0'/0'` (ed25519)
- EVM: `m/44'/60'/0'/0/0` (secp256k1)
- Private keys encrypted at rest using a key derived from the user's PIN/passkey via HKDF
- Use `@noble/ed25519`, `@noble/secp256k1`, `@scure/bip39`, `@scure/bip32` — all audited, pure JS, no native deps

### 4.2 AuthGateService

Mediates all approval. Every signing or sensitive operation must go through here.

```typescript
// services/auth-gate.ts
import { Context, Effect } from "effect"

class AuthGateService extends Context.Tag("AuthGateService")<
  AuthGateService,
  {
    // Request user approval — yields until approved or denied
    readonly requestApproval: (
      request: AuthRequest
    ) => Effect.Effect<AuthApproval, AuthDeniedError | AuthTimeoutError>

    // Register auth methods (called during setup)
    readonly registerPasskey: (credential: unknown) => Effect.Effect<void>
    readonly registerPin: (pinHash: Uint8Array) => Effect.Effect<void>

    // Derive an encryption key from current auth method (for backup encryption)
    readonly deriveEncryptionKey: () => Effect.Effect<
      Uint8Array,
      AuthDeniedError | AuthTimeoutError
    >
  }
>() {}
```

**Implementation notes for testing:**
- Test layer auto-approves all requests, returning a synthetic `AuthApproval`
- Prod layer bridges to native passkey/biometric APIs via React Native module
- Elevated requests (`requiredLevel: "elevated"`) always require passkey, never PIN alone

### 4.3 SignerService

Orchestrates: build tx → get approval → sign → return signed tx.

```typescript
// services/signer.ts
class SignerService extends Context.Tag("SignerService")<
  SignerService,
  {
    readonly sign: (tx: UnsignedTx) => Effect.Effect<
      SignedTx,
      KeyNotFoundError | AuthDeniedError | AuthTimeoutError,
      KeyringService | AuthGateService | ChainAdapterRegistry
    >
  }
>() {}
```

**Implementation:**
```typescript
// Pseudocode for the sign effect
const sign = (tx: UnsignedTx) =>
  Effect.gen(function* () {
    const auth = yield* AuthGateService
    const keyring = yield* KeyringService
    const chains = yield* ChainAdapterRegistry

    // 1. Determine auth level
    const level = tx.estimatedFee && tx.estimatedFee > LARGE_TX_THRESHOLD
      ? "elevated" : "standard"

    // 2. Get approval — blocks until user acts
    const approval = yield* auth.requestApproval({
      reason: tx.metadata.intent,
      requiredLevel: level,
    })

    // 3. Get chain adapter for signing
    const adapter = yield* chains.get(tx.chain)

    // 4. Get raw private key bytes (guarded by approval proof)
    const signed = yield* Effect.gen(function* () {
      const keyBytes = yield* keyring.signBytes(tx.chain, /* tx bytes */, approval)
      return yield* adapter.sign(tx, keyBytes)
    })

    return signed
  })
```

### 4.4 BalanceService

Reads balances across all chains, normalises into a single portfolio.

```typescript
// services/balance.ts
class BalanceService extends Context.Tag("BalanceService")<
  BalanceService,
  {
    // Get single asset balance
    readonly getBalance: (
      chain: ChainId,
      address: string,
      asset: AssetId
    ) => Effect.Effect<TokenBalance, UnsupportedChainError, ChainAdapterRegistry>

    // Get all balances for a derived key
    readonly getPortfolio: (
      keys: readonly DerivedKey[]
    ) => Effect.Effect<Portfolio, never, ChainAdapterRegistry>

    // Portfolio = { balances: TokenBalance[], totalUsdValue?: number }
    // Each TokenBalance = { asset: AssetId, balance: bigint, address: string }
  }
>() {}
```

**Implementation notes:**
- `getPortfolio` fires parallel `getAllBalances` calls across all chains via `Effect.allPar`
- No polling loop in the service itself — the consuming app layer decides refresh strategy

### 4.5 BroadcastService

Submits a signed transaction and waits for confirmation.

```typescript
// services/broadcast.ts
class BroadcastService extends Context.Tag("BroadcastService")<
  BroadcastService,
  {
    readonly submit: (signed: SignedTx) => Effect.Effect<
      TxReceipt,
      BroadcastError,
      ChainAdapterRegistry
    >
  }
>() {}
```

### 4.6 RouterService

Takes a `TransferIntent` and produces a `TransferPlan` — the sequence of transactions needed.

```typescript
// services/router.ts
class RouterService extends Context.Tag("RouterService")<
  RouterService,
  {
    readonly plan: (intent: TransferIntent) => Effect.Effect<
      TransferPlan,
      UnsupportedRouteError | UnsupportedChainError,
      ChainAdapterRegistry
    >
  }
>() {}
```

**Routing logic:**
```
if from.chain === to.chain:
  → single direct-transfer step
if asset is USDC && both chains have CCTP domains:
  → cctp-burn step + cctp-mint step
else:
  → UnsupportedRouteError (no arbitrary bridging — CCTP only for now)
```

### 4.7 CctpService

Manages the CCTP V2 burn → attest → mint lifecycle.

```typescript
// services/cctp.ts
class CctpService extends Context.Tag("CctpService")<
  CctpService,
  {
    // Build the burn transaction for source chain
    readonly buildBurnTx: (params: {
      sourceChain: ChainId
      destChain: ChainId
      amount: bigint
      recipient: string
    }) => Effect.Effect<UnsignedTx, UnsupportedRouteError, ChainAdapterRegistry>

    // Poll Circle attestation API until attestation is available
    // Uses FetchAdapter for HTTP + WalletConfigService for attestation URL and timeouts
    readonly waitForAttestation: (
      burn: BurnMessage
    ) => Effect.Effect<Attestation, CctpAttestationTimeout, FetchAdapter | WalletConfigService>

    // Build the mint/receiveMessage transaction on destination chain
    readonly buildMintTx: (
      attestation: Attestation
    ) => Effect.Effect<UnsignedTx, CctpMintError, ChainAdapterRegistry>

    // Persist and resume pending transfers
    readonly savePending: (transfer: PendingCctpTransfer) => Effect.Effect<void, StorageError, StorageAdapter>
    readonly loadPending: () => Effect.Effect<readonly PendingCctpTransfer[], StorageError, StorageAdapter>
    readonly resumePending: (id: string) => Effect.Effect<
      PendingCctpTransfer,
      CctpAttestationTimeout | CctpMintError | BroadcastError,
      ChainAdapterRegistry | SignerService | StorageAdapter
    >
  }
>() {}
```

**Implementation notes:**
- CCTP V2 contract addresses per chain stored in config
- Attestation polling: `Effect.retry` with exponential backoff, max 30 minutes
- `PendingCctpTransfer` saved to `StorageAdapter` after each status change so app restart can resume
- Circle attestation API: `https://iris-api.circle.com/v2/attestations/{messageHash}`

### 4.8 TransferService

Top-level orchestrator — the main entry point for "send money."

```typescript
// services/transfer.ts
class TransferService extends Context.Tag("TransferService")<
  TransferService,
  {
    readonly execute: (intent: TransferIntent) => Effect.Effect<
      TransferResult,
      | UnsupportedRouteError
      | UnsupportedChainError
      | InsufficientBalanceError
      | AuthDeniedError
      | AuthTimeoutError
      | BroadcastError
      | CctpAttestationTimeout
      | CctpMintError,
      // All dependencies
      | RouterService
      | SignerService
      | BroadcastService
      | BalanceService
      | CctpService
      | ChainAdapterRegistry
      | AuthGateService
      | KeyringService
      | StorageAdapter
    >
  }
>() {}

interface TransferResult {
  readonly planId: string
  readonly steps: readonly CompletedStep[]
  readonly status: "completed" | "pending-cctp"
}

interface CompletedStep {
  readonly type: string
  readonly receipt?: TxReceipt
  readonly pendingCctp?: PendingCctpTransfer
}
```

**Implementation:**
```typescript
const execute = (intent: TransferIntent) =>
  Effect.gen(function* () {
    const router = yield* RouterService
    const signer = yield* SignerService
    const broadcast = yield* BroadcastService
    const balance = yield* BalanceService
    const cctp = yield* CctpService

    // 1. Check balance
    const bal = yield* balance.getBalance(
      intent.from.chain, intent.from.address, intent.asset
    )
    if (bal.balance < intent.amount) {
      yield* Effect.fail(new InsufficientBalanceError({ ... }))
    }

    // 2. Plan
    const plan = yield* router.plan(intent)

    // 3. Execute steps sequentially
    const completedSteps: CompletedStep[] = []

    for (const step of plan.steps) {
      if (step.type === "direct-transfer") {
        const signed = yield* signer.sign(step.tx)
        const receipt = yield* broadcast.submit(signed)
        completedSteps.push({ type: step.type, receipt })
      }
      else if (step.type === "cctp-burn") {
        const signed = yield* signer.sign(step.tx)
        const receipt = yield* broadcast.submit(signed)
        // Extract burn message from receipt (chain-specific parsing)
        const burnMsg = yield* cctp.extractBurnMessage(receipt)
        // Save pending state
        const pending: PendingCctpTransfer = { ... status: "awaiting-attestation" }
        yield* cctp.savePending(pending)
        // Poll for attestation
        const attestation = yield* cctp.waitForAttestation(burnMsg)
        // Build and submit mint tx
        const mintTx = yield* cctp.buildMintTx(attestation)
        const mintSigned = yield* signer.sign(mintTx)
        const mintReceipt = yield* broadcast.submit(mintSigned)
        completedSteps.push({ type: "cctp", receipt: mintReceipt })
      }
    }

    return { planId: plan.id, steps: completedSteps, status: "completed" }
  })
```

---

## 5. Layer Composition & `createWallet`

The consumer's single entry point. Pass a `WalletConfig` + adapter overrides → get a fully wired `Layer`.

### 5.0 `createWallet` factory

```typescript
// create-wallet.ts
import { Layer, Effect } from "effect"

interface WalletAdapterOverrides {
  // All optional — sensible defaults are provided
  readonly storage?: Layer.Layer<StorageAdapter>
  readonly backup?: Layer.Layer<BackupAdapter>
  readonly authGate?: Layer.Layer<AuthGateService>
  readonly fetch?: Layer.Layer<FetchAdapter>
  // Consumer can inject any adapter — fully open
  readonly [key: string]: Layer.Layer<any> | undefined
}

function createWallet(
  config: WalletConfig,
  overrides?: WalletAdapterOverrides
): Layer.Layer<
  | TransferService
  | BalanceService
  | KeyringService
  | SignerService
  | BroadcastService
  | RouterService
  | CctpService
  | WalletConfigService
> {
  // 1. Config layer — always provided
  const configLayer = Layer.succeed(WalletConfigService, {
    config,
    get: (key) => config[key],
    getChain: (chainId) => {
      const found = config.chains.find(c => c.chainId === chainId)
      return found
        ? Effect.succeed(found)
        : Effect.fail(new UnsupportedChainError({ chain: chainId }))
    },
  })

  // 2. Adapters — use overrides or defaults
  const fetchLayer = overrides?.fetch ?? BrowserFetchAdapter.layer
  const storageLayer = overrides?.storage ?? InMemoryStorageAdapter.layer
  const backupLayer = overrides?.backup ?? InMemoryBackupAdapter.layer
  const authLayer = overrides?.authGate ?? TestAuthGate.layer

  // 3. Chain adapter registry — built from config + fetch
  const chainAdapters = ChainAdapterRegistryLive  // reads WalletConfigService + FetchAdapter

  // 4. Compose
  return Layer.mergeAll(
    configLayer,
    fetchLayer,
    storageLayer,
    backupLayer,
    authLayer,
  ).pipe(
    Layer.provideMerge(chainAdapters),
    Layer.provideMerge(KeyringServiceLive),
    Layer.provideMerge(SignerServiceLive),
    Layer.provideMerge(BalanceServiceLive),
    Layer.provideMerge(BroadcastServiceLive),
    Layer.provideMerge(RouterServiceLive),
    Layer.provideMerge(CctpServiceLive),
    Layer.provideMerge(TransferServiceLive),
  )
}
```

### 5.1 Usage — Test (Vitest, no network)

```typescript
// test/helpers/test-layers.ts
import { testConfig } from "./test-config"

// Auto-approving auth gate for tests
const TestAuthGate = Layer.succeed(AuthGateService, {
  requestApproval: (_req) =>
    Effect.succeed({ method: "pin", timestamp: Date.now() }),
  registerPasskey: () => Effect.void,
  registerPin: () => Effect.void,
  deriveEncryptionKey: () =>
    Effect.succeed(new Uint8Array(32)),
})

// Mock fetch that returns deterministic responses per URL pattern
const TestFetch = Layer.succeed(FetchAdapter, MockFetchAdapter.make({
  // attestation API returns instant attestation
  "iris-api.circle.com": () => ({ status: 200, ... }),
}))

export const TestLayer = createWallet(testConfig, {
  authGate: TestAuthGate,
  fetch: TestFetch,
  storage: InMemoryStorageAdapter.layer,
  backup: InMemoryBackupAdapter.layer,
})

// testConfig is a WalletConfig with mock chain RPCs and short timeouts
const testConfig: WalletConfig = {
  chains: [
    { chainId: "aptos", name: "Aptos Devnet", rpcUrl: "mock://aptos", nativeAsset: ... },
    { chainId: "solana", name: "Solana Devnet", rpcUrl: "mock://solana", nativeAsset: ... },
    { chainId: "evm:1", name: "Ethereum Devnet", rpcUrl: "mock://evm", nativeAsset: ... },
  ],
  cctp: {
    attestationApiUrl: "mock://iris-api.circle.com",
    contractAddresses: { ... },
    attestationPollIntervalMs: 10,   // fast for tests
    attestationTimeoutMs: 1000,
  },
  auth: {
    elevatedThreshold: 100_000_000n,
    sessionTtlMs: 60_000,
    pinMinLength: 4,
  },
  keyring: {
    mnemonicStrength: 128,
    derivationPaths: {
      "aptos": "m/44'/637'/0'/0'/0'",
      "solana": "m/44'/501'/0'/0'",
      "evm:1": "m/44'/60'/0'/0/0",
    },
  },
}
```

### 5.2 Usage — Devnet (real RPCs, auto-approve auth)

```typescript
const devnetWallet = createWallet({
  chains: [
    { chainId: "aptos", name: "Aptos Devnet", rpcUrl: "https://fullnode.devnet.aptoslabs.com/v1", ... },
    { chainId: "solana", name: "Solana Devnet", rpcUrl: "https://api.devnet.solana.com", ... },
    { chainId: "evm:11155111", name: "Sepolia", rpcUrl: "https://sepolia.infura.io/v3/YOUR_KEY", ... },
  ],
  cctp: { attestationApiUrl: "https://iris-api-sandbox.circle.com/v2", ... },
  auth: { elevatedThreshold: 100_000_000n, sessionTtlMs: 300_000, pinMinLength: 4 },
  keyring: { mnemonicStrength: 128, derivationPaths: { ... } },
})
// Uses default BrowserFetchAdapter, InMemoryStorage, TestAuthGate
```

### 5.3 Usage — Production (React Native)

```typescript
const prodWallet = createWallet(prodConfig, {
  storage: SecureStorageAdapter.layer,          // React Native SecureStore
  backup: iCloudBackupAdapter.layer,            // or GoogleDriveBackupAdapter
  authGate: NativeAuthGate.layer,               // passkey/biometric bridge
  fetch: NativeFetchAdapter.layer,              // optional: if you need cert pinning or custom headers
})

// Consumer can also pass custom stuff:
const walletWithAnalytics = createWallet({
  ...prodConfig,
  analyticsEndpoint: "https://analytics.example.com",  // open extension
  featureFlags: { cctpEnabled: true, solanaEnabled: false },
}, {
  storage: SecureStorageAdapter.layer,
  authGate: NativeAuthGate.layer,
})
```

---

## 6. Test Strategy

All tests use `Effect.runPromise` with `TestLayer`. No mocking frameworks — Effect's Layer IS the mock boundary.

### Example: KeyringService test

```typescript
// test/keyring.test.ts
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { TestLayer } from "./helpers/test-layers"  // = createWallet(testConfig, { ... })

describe("KeyringService", () => {
  it("generates keys for all supported chains", async () => {
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const { mnemonic, keys } = yield* keyring.generate()

      expect(mnemonic.phrase.split(" ").length).toBe(12)
      expect(keys).toHaveLength(3) // aptos, solana, evm
      expect(keys.map(k => k.chain)).toEqual(
        expect.arrayContaining(["aptos", "solana", "evm:1"])
      )
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("round-trips through encrypted export/import", async () => {
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const { keys } = yield* keyring.generate()
      const encKey = new Uint8Array(32).fill(0x42)

      const bundle = yield* keyring.exportEncrypted(encKey)
      const imported = yield* keyring.importEncrypted(bundle, encKey)

      expect(imported.map(k => k.address)).toEqual(keys.map(k => k.address))
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })
})
```

### Example: Full transfer flow test

```typescript
// test/transfer.test.ts
describe("TransferService", () => {
  it("executes same-chain transfer end to end", async () => {
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const { keys } = yield* keyring.generate()

      const aptosKey = keys.find(k => k.chain === "aptos")!

      const result = yield* transfer.execute({
        from: { chain: "aptos", address: aptosKey.address },
        to: { chain: "aptos", address: "0xdeadbeef" },
        asset: USDC["aptos"],
        amount: 10_000_000n, // 10 USDC
      })

      expect(result.status).toBe("completed")
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0].receipt?.status).toBe("confirmed")
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("executes cross-chain CCTP transfer", async () => {
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const { keys } = yield* keyring.generate()

      const result = yield* transfer.execute({
        from: { chain: "solana", address: keys.find(k => k.chain === "solana")!.address },
        to: { chain: "evm:1", address: keys.find(k => k.chain === "evm:1")!.address },
        asset: USDC["solana"],
        amount: 50_000_000n, // 50 USDC
      })

      expect(result.status).toBe("completed")
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("fails with UnsupportedRouteError for non-USDC cross-chain", async () => {
    const program = Effect.gen(function* () {
      const keyring = yield* KeyringService
      const transfer = yield* TransferService
      const { keys } = yield* keyring.generate()

      const result = yield* Effect.either(transfer.execute({
        from: { chain: "solana", address: keys.find(k => k.chain === "solana")!.address },
        to: { chain: "evm:1", address: "0x..." },
        asset: { chain: "solana", type: "native", symbol: "SOL", decimals: 9 },
        amount: 1_000_000_000n,
      }))

      expect(result._tag).toBe("Left")
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })
})
```

---

## 7. Chain Adapter Implementation Notes

### Aptos
- SDK: `@aptos-labs/ts-sdk`
- Transaction building: `aptos.transaction.build.simple()`
- Ed25519 signing
- CCTP contracts: Circle's Aptos TokenMessenger (if live), otherwise defer

### Solana
- SDK: `@solana/web3.js` v2 (functional style aligns well with Effect)
- Ed25519 signing
- CCTP: `@noble/curves/ed25519` for signing, Circle's Solana CCTP program IDs

### EVM
- SDK: `viem` (functional, tree-shakeable, TypeScript-first)
- secp256k1 signing
- CCTP: `TokenMessenger.depositForBurn()` on source, `MessageTransmitter.receiveMessage()` on dest
- Support multiple EVM chains via `chainId` in config

---

## 8. Backup Flow

```
User taps "Backup"
  → TransferService (or dedicated BackupService) calls:
    1. AuthGateService.requestApproval({ requiredLevel: "elevated" })
    2. AuthGateService.deriveEncryptionKey()
    3. KeyringService.exportEncrypted(encryptionKey)
    4. BackupAdapter.exportBackup(bundle, manifest)

User taps "Restore"
  → 1. BackupAdapter.importBackup()  → { bundle, manifest }
    2. AuthGateService.requestApproval({ requiredLevel: "elevated" })
    3. User enters PIN/passkey that was used to encrypt
    4. KeyringService.importEncrypted(bundle, encryptionKey)
    5. All DerivedKeys restored, balances refreshable
```

---

## 9. Dependency Graph

```
TransferService
  ├── RouterService
  │     └── ChainAdapterRegistry
  ├── SignerService
  │     ├── AuthGateService
  │     ├── KeyringService
  │     │     └── StorageAdapter
  │     └── ChainAdapterRegistry
  ├── BroadcastService
  │     └── ChainAdapterRegistry
  ├── BalanceService
  │     └── ChainAdapterRegistry
  └── CctpService
        ├── ChainAdapterRegistry
        ├── FetchAdapter (attestation polling)
        ├── WalletConfigService (attestation URL, timeouts)
        ├── StorageAdapter
        └── (SignerService — for resumePending)

ChainAdapterRegistry
  ├── WalletConfigService (reads chains array)
  └── FetchAdapter (each adapter uses this for RPC)

WalletConfigService ← pure, no deps, provided by createWallet()
FetchAdapter ← pure, no deps, default = BrowserFetchAdapter
StorageAdapter ← pure, no deps
BackupAdapter ← pure, no deps
AuthGateService ← pure, no deps
```

---

## 10. Package Dependencies

```json
{
  "name": "@wallet/core",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./adapters/*": { "import": "./dist/adapters/*/index.js" },
    "./config": { "import": "./dist/config/index.js" },
    "./test": { "import": "./dist/test/helpers/test-layers.js" }
  },
  "dependencies": {
    "effect": "^3.x",
    "@scure/bip39": "^1.x",
    "@scure/bip32": "^1.x",
    "@noble/ed25519": "^2.x",
    "@noble/secp256k1": "^2.x",
    "@noble/hashes": "^1.x",
    "@aptos-labs/ts-sdk": "^2.x",
    "@solana/web3.js": "^2.x",
    "viem": "^2.x"
  },
  "devDependencies": {
    "vitest": "^3.x",
    "typescript": "^5.x"
  },
  "browser": true
}
```

---

## 11. Implementation Order

Build and test in this sequence — each step is independently testable before the next:

1. **Models** — all types in `model/`, no logic, just `Data.TaggedError` and interfaces
2. **WalletConfig + WalletConfigService** — config type, tag, default values. Test: `getChain` returns correct config or `UnsupportedChainError`
3. **FetchAdapter** — `BrowserFetchAdapter` (wraps `globalThis.fetch`), `MockFetchAdapter` (returns canned responses keyed by URL pattern). Test: mock adapter returns expected responses
4. **StorageAdapter** — `InMemoryStorageAdapter` first, trivial to implement
5. **KeyringService** — generate mnemonic, derive keys, encrypt/decrypt at rest. Uses `WalletConfigService` for derivation paths. Test: generate → export → import round-trip
6. **AuthGateService** — test impl that auto-approves. Test: approval flow yields correct `AuthApproval`
7. **ChainAdapterRegistry + mock adapters** — `MockChainAdapter` returns deterministic results. `ChainAdapterRegistryLive` reads `WalletConfigService.config.chains` and `FetchAdapter`. Test: registry lookup, buildTx, sign
8. **SignerService** — wires keyring + auth + chain adapter. Test: sign returns valid `SignedTx`, auth denial propagates
9. **BroadcastService** — thin, delegates to chain adapter. Test: submit returns receipt
10. **BalanceService** — parallel balance fetching. Test: portfolio aggregation across mock chains
11. **RouterService** — intent → plan decomposition. Test: same-chain → 1 step, cross-chain USDC → 2 CCTP steps, unsupported → error
12. **CctpService** — burn/attest/mint lifecycle. Uses `FetchAdapter` for attestation polling, `WalletConfigService` for URLs/timeouts. Test: full cycle with mock fetch, pending state persistence and resume
13. **TransferService** — full orchestrator. Test: end-to-end same-chain, end-to-end cross-chain, error propagation
14. **`createWallet` factory** — wires everything. Test: `createWallet(testConfig)` produces a working `Layer`, all services resolve
15. **Real chain adapters** — Aptos, Solana, EVM against devnets. Test: real tx build + broadcast on devnets (uses `BrowserFetchAdapter`)
16. **BackupAdapter** — iCloud / Google Drive / file export. Test: round-trip backup/restore
17. **Production AuthGateService** — bridge to native passkey/biometric. Manual testing on device
