# COW API Reference

Complete type signatures for `cow-wallet`.

## Factory functions

```typescript
// Promise API — no Effect knowledge needed
function createWalletClient(
  config: WalletConfig,
  overrides?: WalletAdapterOverrides,
): WalletClient

// Effect API — for advanced composition
function createWallet(
  config: WalletConfig,
  overrides?: WalletAdapterOverrides,
): WalletLayer
```

## WalletAdapterOverrides

```typescript
interface WalletAdapterOverrides {
  readonly storage?: Layer.Layer<StorageAdapter>
  readonly backup?: Layer.Layer<BackupAdapter>
  readonly authGate?: Layer.Layer<AuthGateService>
  readonly fetch?: Layer.Layer<FetchAdapter>
  readonly chainRegistry?: Layer.Layer<ChainAdapterRegistry, never, WalletConfigService | FetchAdapter>
}
```

## Config types

```typescript
interface WalletConfig {
  readonly chains: readonly ChainConfig[]
  readonly cctp: CctpConfig
  readonly auth: AuthConfig
  readonly keyring: KeyringConfig
  readonly [key: string]: unknown  // open for app-specific extensions
}

interface ChainConfig {
  readonly chainId: ChainId
  readonly name: string
  readonly rpcUrl: string
  readonly nativeAsset: AssetId
  readonly cctpDomain?: number
  readonly kind: "aptos" | "solana" | "evm" | "mock"
  readonly [key: string]: unknown
}

interface CctpConfig {
  readonly attestationApiUrl: string
  readonly contractAddresses: Partial<Record<ChainId, {
    readonly tokenMessenger: string
    readonly messageTransmitter: string
    readonly usdcToken: string
  }>>
  readonly attestationPollIntervalMs: number
  readonly attestationTimeoutMs: number
}

interface AuthConfig {
  readonly elevatedThreshold: bigint
  readonly sessionTtlMs: number
  readonly pinMinLength: number
}

interface KeyringConfig {
  readonly mnemonicStrength: 128 | 256
  readonly derivationPaths: Partial<Record<ChainId, string>>
}
```

## Model types

```typescript
type ChainId = "aptos" | "solana" | `evm:${string}` | (string & {})

interface ChainAddress {
  readonly chain: ChainId
  readonly address: string
}

interface AssetId {
  readonly chain: ChainId
  readonly type: "native" | "token"
  readonly address?: string
  readonly symbol: string
  readonly decimals: number
}

interface DerivedKey {
  readonly chain: ChainId
  readonly publicKey: Uint8Array
  readonly address: string
  readonly accountIndex: number
  readonly path: DerivationPath
}

interface DerivationPath {
  readonly chain: ChainId
  readonly path: string
  readonly accountIndex: number
}

interface Mnemonic {
  readonly phrase: string
  readonly entropy: Uint8Array
}

interface TokenBalance {
  readonly asset: AssetId
  readonly balance: bigint
  readonly address: string
}

interface Portfolio {
  readonly balances: readonly TokenBalance[]
  readonly totalUsdValue?: number
}

interface TransferIntent {
  readonly from: ChainAddress
  readonly to: ChainAddress
  readonly asset: AssetId
  readonly amount: bigint
}

interface TransferPlan {
  readonly id: string
  readonly intent: TransferIntent
  readonly steps: readonly TransferStep[]
  readonly isCrossChain: boolean
}

type TransferStep =
  | { type: "direct-transfer"; chain: ChainId; tx: UnsignedTx }
  | { type: "cctp-burn"; sourceChain: ChainId; destChain: ChainId; tx: UnsignedTx }
  | { type: "cctp-mint"; destChain: ChainId }

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

interface UnsignedTx {
  readonly chain: ChainId
  readonly from: string
  readonly payload: unknown
  readonly estimatedFee?: bigint
  readonly metadata: TxMetadata
}

interface SignedTx {
  readonly chain: ChainId
  readonly raw: Uint8Array
  readonly hash: string
  readonly unsigned: UnsignedTx
}

interface TxReceipt {
  readonly chain: ChainId
  readonly hash: string
  readonly status: "confirmed" | "failed"
  readonly blockNumber?: bigint
  readonly fee?: bigint
  readonly raw?: unknown
}

interface TxMetadata {
  readonly intent: string
  readonly createdAt: number
  readonly transferId?: string
}

type AuthMethod = "passkey" | "pin" | "biometric"
type AuthLevel = "standard" | "elevated"

interface AuthRequest {
  readonly reason: string
  readonly requiredLevel: AuthLevel
}

interface AuthApproval {
  readonly method: AuthMethod
  readonly timestamp: number
  readonly sessionToken?: string
}

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
  readonly attestation: string
}

type CctpTransferStatus =
  | "burning" | "awaiting-attestation" | "attested"
  | "minting" | "completed" | "failed"

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

interface ResumeResult {
  readonly transfer: PendingCctpTransfer
  readonly mintReceipt: TxReceipt
}

interface BackupManifest {
  readonly version: number
  readonly createdAt: number
  readonly chains: readonly ChainId[]
  readonly addressCount: number
  readonly checksum: string
}
```

## Error types

All extend `Data.TaggedError` and have a `_tag` string discriminator.

```typescript
class KeyGenerationError      { _tag: "KeyGenerationError";      message: string }
class KeyNotFoundError        { _tag: "KeyNotFoundError";        chain: string; address?: string }
class AuthDeniedError         { _tag: "AuthDeniedError";         reason: string }
class AuthTimeoutError        { _tag: "AuthTimeoutError";        reason?: string }
class InsufficientBalanceError{ _tag: "InsufficientBalanceError"; chain: string; required: bigint; available: bigint }
class BroadcastError          { _tag: "BroadcastError";          chain: string; hash?: string; cause: unknown }
class FeeEstimationError      { _tag: "FeeEstimationError";      chain: string; cause: unknown }
class CctpAttestationTimeout  { _tag: "CctpAttestationTimeout";  burnTxHash: string; elapsedMs: number }
class CctpMintError           { _tag: "CctpMintError";           destChain: string; cause: unknown }
class UnsupportedChainError   { _tag: "UnsupportedChainError";   chain: string }
class UnsupportedRouteError   { _tag: "UnsupportedRouteError";   from: string; to: string; asset: string }
class StorageError            { _tag: "StorageError";            operation: "read"|"write"|"delete"|"list"; key: string; cause: unknown }
class BackupError             { _tag: "BackupError";             provider: string; operation: "export"|"import"|"status"; cause: unknown }
class BackupDecryptionError   { _tag: "BackupDecryptionError";   message: string }
class FetchError              { _tag: "FetchError";              url: string; status?: number; cause: unknown }
```

## Adapter hook interfaces

### SecureStoreHooks (storage)

```typescript
interface SecureStoreHooks {
  readonly save: (key: string, value: Uint8Array) => Promise<void>
  readonly load: (key: string) => Promise<Uint8Array | null>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix: string) => Promise<readonly string[]>
}

interface StringBackedSecureStoreHooks {
  readonly save: (key: string, valueBase64: string) => Promise<void>
  readonly load: (key: string) => Promise<string | null>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix: string) => Promise<readonly string[]>
}
```

### CallbackAuthGateHooks (auth)

```typescript
interface CallbackAuthGateHooks {
  readonly promptApproval: (request: AuthRequest) => Promise<AuthApproval | null>
  readonly getEncryptionKey: () => Promise<Uint8Array>
  readonly registerPasskey?: (credential: unknown) => Promise<void>
  readonly registerPin?: (pinHash: Uint8Array) => Promise<void>
  readonly timeoutMs?: number
}
```

### WebAuthnAuthGateOptions (browser passkeys)

```typescript
interface WebAuthnAuthGateOptions {
  readonly rpId: string
  readonly credentialIds: readonly Uint8Array[]
  readonly userVerification?: "required" | "preferred" | "discouraged"
  readonly keyDerivationContext?: string
  readonly timeoutMs?: number
}
```

### BridgedBackupHooks (iCloud / Google Drive)

```typescript
interface BridgedBackupHooks {
  readonly provider: string
  readonly saveFile: (file: Uint8Array, manifest: BackupManifest) => Promise<void>
  readonly loadFile: () => Promise<{ file: Uint8Array } | null>
  readonly checkStatus: () => Promise<{ exists: boolean; lastBackup?: number }>
}
```

## FetchAdapter types

```typescript
interface FetchRequest {
  readonly url: string
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
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
```

## Built-in constants

```typescript
const DEFAULT_DERIVATION_PATHS: Partial<Record<ChainId, string>> = {
  aptos: "m/44'/637'/0'/0'/0'",
  solana: "m/44'/501'/0'/0'",
  "evm:1": "m/44'/60'/0'/0/0",
  "evm:8453": "m/44'/60'/0'/0/0",
  "evm:42161": "m/44'/60'/0'/0/0",
  "evm:11155111": "m/44'/60'/0'/0/0",
}

const CCTP_DOMAINS: Partial<Record<ChainId, number>> = {
  "evm:1": 0, "evm:43114": 1, "evm:10": 2, "evm:42161": 3,
  solana: 5, "evm:8453": 6, aptos: 9, "evm:11155111": 0,
}

const USDC_ASSETS: Partial<Record<ChainId, AssetId>> = {
  aptos:  { chain: "aptos",  type: "token", symbol: "USDC", decimals: 6, address: "0xbae207..." },
  solana: { chain: "solana", type: "token", symbol: "USDC", decimals: 6, address: "EPjFWdd5..." },
  "evm:1":{ chain: "evm:1", type: "token", symbol: "USDC", decimals: 6, address: "0xA0b869..." },
}

const DEFAULT_CCTP_POLL_INTERVAL_MS = 2_000
const DEFAULT_CCTP_TIMEOUT_MS = 1_800_000
```

## Effect service tags (for advanced users)

```typescript
KeyringService        // key generation, derivation, signing
AuthGateService       // approval flow
SignerService         // tx signing orchestrator
BalanceService        // balance queries
BroadcastService      // tx submission
RouterService         // intent -> plan
CctpService           // CCTP burn/attest/mint lifecycle
TransferService       // top-level transfer orchestrator
WalletConfigService   // config access
ChainAdapterRegistry  // per-chain adapter lookup
StorageAdapter        // key/value persistence
BackupAdapter         // backup export/import
FetchAdapter          // HTTP abstraction
```
