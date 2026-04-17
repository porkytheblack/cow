# COW (COol Wallet) - Agent & Developer Coding Guide

## What is COW?

COW is a multichain wallet TypeScript library at `packages/wallet-core`. It supports Aptos, Solana, and EVM chains with CCTP V2 cross-chain USDC transfers. Built on Effect TS internally, it exposes a **promise-based client** (`createWalletClient`) that requires zero Effect knowledge.

## Two APIs

### 1. Promise API (recommended for app code)

```typescript
import { createWalletClient } from "cow-wallet/client"
// or: import { createWalletClient } from "cow-wallet"

const wallet = createWalletClient(config)
const { mnemonic, keys } = await wallet.generate()
```

### 2. Effect API (for advanced composition, testing, custom layers)

```typescript
import { createWallet, KeyringService, TransferService } from "cow-wallet"
import { Effect } from "effect"

const layer = createWallet(config)
const program = Effect.gen(function* () {
  const keyring = yield* KeyringService
  return yield* keyring.generate()
})
await Effect.runPromise(Effect.provide(program, layer))
```

**Always default to the promise API** unless the task explicitly involves Effect composition, custom Layer overrides, or test harness wiring.

## WalletConfig Shape

Every wallet starts with a config. This is the minimum viable shape:

```typescript
import type { WalletConfig } from "cow-wallet"

const config: WalletConfig = {
  chains: [
    {
      chainId: "evm:1",          // ChainId: "aptos" | "solana" | "evm:<number>" | string
      kind: "evm",               // "evm" | "solana" | "aptos" | "mock"
      name: "Ethereum",
      rpcUrl: "https://eth.llamarpc.com",
      cctpDomain: 0,             // optional: Circle CCTP domain for cross-chain
      nativeAsset: { chain: "evm:1", type: "native", symbol: "ETH", decimals: 18 },
    },
    // ... more chains
  ],
  cctp: {
    attestationApiUrl: "https://iris-api.circle.com/v2",
    contractAddresses: {
      "evm:1": {
        tokenMessenger: "0x...",
        messageTransmitter: "0x...",
        usdcToken: "0x...",
      },
    },
    attestationPollIntervalMs: 2000,
    attestationTimeoutMs: 1800000,   // 30 minutes
  },
  auth: {
    elevatedThreshold: 100_000_000n, // fee above this -> passkey required
    sessionTtlMs: 300_000,
    pinMinLength: 4,
  },
  keyring: {
    mnemonicStrength: 128,           // 128 = 12 words, 256 = 24 words
    derivationPaths: {
      "evm:1": "m/44'/60'/0'/0/0",
      solana: "m/44'/501'/0'/0'",
      aptos: "m/44'/637'/0'/0'/0'",
    },
  },
}
```

`WalletConfig` also has an open index signature (`[key: string]: unknown`) for app-specific extensions like feature flags, analytics keys, etc.

## WalletClient Methods Reference

```typescript
interface WalletClient {
  // Keyring
  generate(): Promise<{ mnemonic: Mnemonic; keys: readonly DerivedKey[] }>
  importMnemonic(phrase: string): Promise<readonly DerivedKey[]>
  importPrivateKey(chain: ChainId, privateKey: Uint8Array, options?: { overwrite?: boolean; accountIndex?: number }): Promise<DerivedKey>
  addAccount(chain: ChainId): Promise<DerivedKey>
  getKey(chain: ChainId, address?: string): Promise<DerivedKey>
  listKeys(): Promise<readonly DerivedKey[]>

  // Balances
  getBalance(chain: ChainId, address: string, asset: AssetId): Promise<TokenBalance>
  getPortfolio(keys?: readonly DerivedKey[]): Promise<Portfolio>  // no-arg = auto-list all

  // Transfers
  transfer(intent: TransferIntent): Promise<TransferResult>
  planTransfer(intent: TransferIntent): Promise<TransferPlan>

  // Low-level signing
  sign(tx: UnsignedTx): Promise<SignedTx>
  broadcast(signed: SignedTx): Promise<TxReceipt>

  // Arbitrary contract / program / entry-function calls
  buildCall(req: CallRequest): Promise<UnsignedTx>
  sendCall(req: CallRequest): Promise<TxReceipt>
  simulateCall(req: CallRequest): Promise<CallSimulation>

  // CCTP resume (after app restart mid-transfer)
  listPendingTransfers(): Promise<readonly PendingCctpTransfer[]>
  resumeTransfer(id: string, recipient?: string, destChain?: ChainId): Promise<ResumeResult>

  // Sessions (approve once, sign many)
  approveSession(reason: string, level?: "standard" | "elevated"): Promise<AuthApproval>
  endSession(): Promise<void>
  hasActiveSession(): Promise<boolean>

  // Utilities
  parseUnits(amount: string, decimals: number): bigint
  formatUnits(amount: bigint, decimals: number): string
  asset(symbol: string, chain: ChainId): AssetId | undefined
  dispose(): Promise<void>

  // Backup
  exportBackup(encryptionKey: Uint8Array): Promise<Uint8Array>
  importBackup(bundle: Uint8Array, encryptionKey: Uint8Array): Promise<readonly DerivedKey[]>
  deriveEncryptionKey(): Promise<Uint8Array>

  // Escape hatch to Effect layer
  readonly layer: WalletLayer
}
```

## Key Types

```typescript
// Chain identifier
type ChainId = "aptos" | "solana" | `evm:${string}` | (string & {})

// Asset descriptor
interface AssetId {
  chain: ChainId
  type: "native" | "token"
  address?: string        // token contract address; omit for native
  symbol: string
  decimals: number
}

// Transfer intent — what the user wants
interface TransferIntent {
  from: ChainAddress      // { chain: ChainId, address: string }
  to: ChainAddress
  asset: AssetId
  amount: bigint          // in smallest unit (wei, lamports, etc.)
}

// Derived key — one per chain per account
interface DerivedKey {
  chain: ChainId
  publicKey: Uint8Array
  address: string
  accountIndex: number    // BIP-44 account index (0, 1, 2, ...)
  path: DerivationPath
}

// Balance
interface TokenBalance { asset: AssetId; balance: bigint; address: string }
interface Portfolio { balances: readonly TokenBalance[]; totalUsdValue?: number }

// Transfer result
interface TransferResult {
  planId: string
  steps: readonly CompletedStep[]
  status: "completed" | "pending-cctp"
}
```

## Common Patterns

### Create wallet and generate keys

```typescript
const wallet = createWalletClient(config)
const { mnemonic, keys } = await wallet.generate()
// Store mnemonic.phrase securely for the user
```

### Restore from mnemonic

```typescript
const keys = await wallet.importMnemonic("abandon abandon abandon ...")
```

### Import a raw private key

```typescript
const key = await wallet.importPrivateKey("evm:1", hexToBytes(pkHex))
```

### Multiple accounts on the same chain

```typescript
await wallet.generate()
const acct1 = await wallet.addAccount("evm:1")   // index 1
const acct2 = await wallet.addAccount("evm:1")   // index 2
const all = await wallet.listKeys()               // includes all indices
```

### Check balance for a specific token

```typescript
const usdc: AssetId = {
  chain: "evm:1", type: "token", symbol: "USDC",
  decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
}
const bal = await wallet.getBalance("evm:1", address, usdc)
// bal.balance is bigint in smallest unit (1_000_000 = 1 USDC)
```

### Aggregate portfolio across all accounts and chains

```typescript
const portfolio = await wallet.getPortfolio()  // auto-lists keys
portfolio.balances.forEach(b =>
  console.log(`${b.asset.chain} ${b.asset.symbol}: ${b.balance}`)
)
```

### Same-chain transfer

```typescript
const result = await wallet.transfer({
  from: { chain: "evm:1", address: senderAddress },
  to: { chain: "evm:1", address: recipientAddress },
  asset: usdc,
  amount: 10_000_000n, // 10 USDC
})
// result.status === "completed"
```

### Cross-chain USDC transfer (CCTP)

```typescript
const result = await wallet.transfer({
  from: { chain: "evm:1", address: senderAddress },
  to: { chain: "evm:8453", address: recipientOnBase },
  asset: { chain: "evm:1", type: "token", symbol: "USDC", decimals: 6, address: "0x..." },
  amount: 50_000_000n,
})
// Automatically: burn on Ethereum -> poll Circle attestation -> mint on Base
```

### Resume a CCTP transfer after app restart

```typescript
// On app startup — check for interrupted transfers
const pending = await wallet.listPendingTransfers()
for (const t of pending) {
  if (t.status !== "completed" && t.status !== "failed") {
    const { mintReceipt } = await wallet.resumeTransfer(t.id)
    // recipient + destChain read from the stored record automatically
  }
}
```

### Auth session for batch operations

```typescript
await wallet.approveSession("Send USDC to 5 recipients")
for (const intent of intents) {
  await wallet.transfer(intent) // auto-approved, no extra prompts
}
await wallet.endSession()
```

Sessions span CCTP cross-chain transfers — burn and mint sign within one session. Default `"elevated"` level covers all request levels. TTL is `auth.sessionTtlMs` (default 5 min).

### Resume interrupted CCTP transfers

```typescript
const pending = await wallet.listPendingTransfers()
for (const t of pending) {
  if (t.status !== "completed" && t.status !== "failed") {
    await wallet.resumeTransfer(t.id) // recipient/destChain from stored record
  }
}
```

### Dry-run a transfer (plan without executing)

```typescript
const plan = await wallet.planTransfer(intent)
console.log(plan.isCrossChain) // true/false
console.log(plan.steps)        // [{ type: "direct-transfer", ... }] or [{ type: "cctp-burn" }, { type: "cctp-mint" }]
```

### Arbitrary contract calls

For anything beyond native / USDC transfers — contract interactions, program invocations, entry functions — use the `CallRequest` APIs. They reuse the same key-isolated signing, auth-gate, and broadcast pipeline as `transfer()`, so sessions, elevated-fee escalation, and promise-shaped errors all behave identically.

```typescript
import { encodeFunctionData } from "viem"

// EVM: approve USDC for a router contract.
const data = encodeFunctionData({
  abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
          inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
          outputs: [{ type: "bool" }] }] as const,
  functionName: "approve",
  args: ["0xRouter...", 10_000_000n],
})

const receipt = await wallet.sendCall({
  kind: "evm",
  chain: "evm:1",
  from: evmKey.address,
  to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  data,
  value: 0n,
  label: "Approve USDC for Router",
})
```

```typescript
// Solana: invoke the Memo program (or any program) with raw instructions.
const receipt = await wallet.sendCall({
  kind: "solana",
  chain: "solana",
  from: solanaKey.address,
  instructions: [
    {
      programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      keys: [{ pubkey: solanaKey.address, isSigner: true, isWritable: false }],
      data: new TextEncoder().encode("hello"),
    },
  ],
  label: "Post memo",
})
```

```typescript
// Aptos: call any entry function by fully-qualified path.
const receipt = await wallet.sendCall({
  kind: "aptos",
  chain: "aptos",
  from: aptosKey.address,
  function: "0x1::coin::transfer",
  typeArguments: ["0x1::aptos_coin::AptosCoin"],
  functionArguments: [recipient, "1000"],
  label: "Custom APT transfer",
})
```

Three methods are available, all with the same `CallRequest`:

- `wallet.buildCall(req)` → `UnsignedTx` — build without signing (useful for fee inspection or deferred signing; then call `wallet.sign()` + `wallet.broadcast()`).
- `wallet.sendCall(req)` → `TxReceipt` — build + sign + broadcast.
- `wallet.simulateCall(req)` → `{ success, returnData?, revertReason?, gasUsed?, logs?, raw? }` — dry-run (EVM `eth_call`, Solana `simulateTransaction`, Aptos `simulate.simple`).

Sessions apply identically — wrap many calls under one prompt:

```typescript
await wallet.approveSession("Interact with Uniswap")
await wallet.sendCall({ kind: "evm", chain: "evm:1", from, to: router, data: swap1 })
await wallet.sendCall({ kind: "evm", chain: "evm:1", from, to: router, data: swap2 })
await wallet.endSession()
```

### Encrypted backup + restore

```typescript
const encKey = await wallet.deriveEncryptionKey()
const bundle = await wallet.exportBackup(encKey)
// ... save bundle bytes to cloud/file ...

// Later:
const restoredKeys = await wallet.importBackup(bundle, encKey)
```

## Error Handling

All errors have a `_tag` string discriminator:

```typescript
try {
  await wallet.transfer(intent)
} catch (e) {
  switch (e._tag) {
    case "InsufficientBalanceError":
      // e.chain, e.required, e.available
      break
    case "UnsupportedRouteError":
      // e.from, e.to, e.asset — only USDC cross-chain via CCTP is supported
      break
    case "AuthDeniedError":
      // e.reason — user denied the signing prompt
      break
    case "AuthTimeoutError":
      // e.reason — approval prompt timed out
      break
    case "CctpAttestationTimeout":
      // e.burnTxHash, e.elapsedMs — can resume later
      break
    case "KeyNotFoundError":
      // e.chain, e.address — no key for this chain/address
      break
    case "BroadcastError":
      // e.chain, e.hash, e.cause — tx submission failed
      break
    case "UnsupportedChainError":
      // e.chain — chain not in config
      break
  }
}
```

## Production Adapter Overrides

### Authentication

Default: auto-approves everything (dev only). Override for production:

```typescript
import { createWalletClient, makeCallbackAuthGate } from "cow-wallet"

createWalletClient(config, {
  authGate: makeCallbackAuthGate({
    promptApproval: async (request) => {
      // request.reason: "Transfer 10 USDC to 0x..."
      // request.requiredLevel: "standard" | "elevated"
      // Return { method: "biometric", timestamp: Date.now() } or null to deny
    },
    getEncryptionKey: async () => encryptionKeyBytes,
    timeoutMs: 300_000,
  }),
})
```

Browser passkeys:
```typescript
import { makeWebAuthnAuthGate } from "cow-wallet"

createWalletClient(config, {
  authGate: makeWebAuthnAuthGate({
    rpId: "wallet.example.com",
    credentialIds: [credentialIdBytes],
  }),
})
```

### Persistent Storage

Default: in-memory (clears on refresh). Override:

```typescript
import { makeSecureStorageAdapter } from "cow-wallet"

createWalletClient(config, {
  storage: makeSecureStorageAdapter({
    save: (key, value) => nativeSecureStore.set(key, value),
    load: (key) => nativeSecureStore.get(key),
    delete: (key) => nativeSecureStore.delete(key),
    list: (prefix) => nativeSecureStore.keys(prefix),
  }),
})
```

String-backed variant (auto base64):
```typescript
import { makeStringSecureStorageAdapter } from "cow-wallet"
```

### Backup Providers

```typescript
import { iCloudBackupAdapter, googleDriveBackupAdapter } from "cow-wallet"

createWalletClient(config, {
  backup: iCloudBackupAdapter({
    saveFile: (file, manifest) => nativeICloud.save(file),
    loadFile: () => nativeICloud.load(),
    checkStatus: () => nativeICloud.status(),
  }),
})
```

## Writing Tests

Use `cow-wallet/test` for the pre-wired test harness:

```typescript
import { makeTestHarness } from "cow-wallet/test"
import { Effect } from "effect"
import { KeyringService, TransferService } from "cow-wallet"

const { layer, seed } = makeTestHarness()

// Seed mock balances
seed(address, usdcAsset, 100_000_000n)

// Run Effect programs against the test layer
const program = Effect.gen(function* () {
  const keyring = yield* KeyringService
  const transfer = yield* TransferService
  const { keys } = yield* keyring.generate()
  return yield* transfer.execute(intent)
})
await Effect.runPromise(Effect.provide(program, layer))
```

For promise-based tests, use `createWalletClient` with mock adapters:

```typescript
import { createWalletClient, makeMockFetchAdapter, makeChainAdapterRegistryLayer, makeMockChainAdapter } from "cow-wallet"

const adapters = new Map()
for (const chain of config.chains) {
  adapters.set(chain.chainId, makeMockChainAdapter(chain))
}

const wallet = createWalletClient(config, {
  chainRegistry: makeChainAdapterRegistryLayer(adapters),
  fetch: makeMockFetchAdapter({ handlers: [...], fallbackTo404: true }),
})
```

## Routing Logic

```
if from.chain === to.chain:
  -> single direct-transfer step

if asset is USDC && both chains have cctpDomain:
  -> cctp-burn step + cctp-mint step (automatic attestation polling)

else:
  -> UnsupportedRouteError
```

## Important Constraints

- **Browser/RN safe**: zero Node.js APIs. Uses `Uint8Array` everywhere (no `Buffer`), `globalThis.crypto` for randomness, `fetch` via injected `FetchAdapter`.
- **Private keys never leave `KeyringService`**: signing happens inside the service; only signatures cross the boundary.
- **All HTTP goes through `FetchAdapter`**: no direct `fetch` calls in any service or adapter.
- **Amounts are always `bigint`** in the smallest unit: `1_000_000n` = 1 USDC (6 decimals), `1_000_000_000n` = 1 SOL (9 decimals), `1_000_000_000_000_000_000n` = 1 ETH (18 decimals).
- **`importMnemonic` overwrites all stored keys**: imported private keys are lost on mnemonic re-import (same as MetaMask behavior).
- **CCTP only supports USDC cross-chain**: non-USDC cross-chain transfers throw `UnsupportedRouteError`.

## File Layout

```
packages/wallet-core/
  src/
    client.ts                      # createWalletClient (promise API)
    create-wallet.ts               # createWallet (Effect API)
    index.ts                       # public barrel
    config/
      index.ts                     # WalletConfig, WalletConfigService
      defaults.ts                  # DEFAULT_DERIVATION_PATHS, CCTP_DOMAINS, USDC_ASSETS
    model/
      chain.ts, asset.ts, transaction.ts, transfer.ts,
      keyring.ts, auth.ts, balance.ts, cctp.ts, errors.ts
    adapters/
      chain/                       # ChainAdapter + EVM/Solana/Aptos/Mock impls
      storage/                     # StorageAdapter + InMemory/SecureStore
      backup/                      # BackupAdapter + InMemory/FileExport/Bridged
      fetch/                       # FetchAdapter + Browser/Mock
    services/
      keyring.ts                   # key generation, derivation, signing
      auth-gate.ts                 # approval flow (test/callback/webauthn)
      signer.ts                    # tx signing orchestrator
      balance.ts                   # balance queries
      broadcast.ts                 # tx submission
      router.ts                    # transfer intent -> plan
      cctp.ts                      # CCTP burn/attest/mint lifecycle
      transfer.ts                  # top-level transfer orchestrator
  test/
    helpers/test-layers.ts         # makeTestHarness()
    helpers/test-config.ts         # testConfig
    *.test.ts
```

## Defaults & Constants

```typescript
import {
  DEFAULT_DERIVATION_PATHS,       // { aptos: "m/44'/637'/0'/0'/0'", solana: "m/44'/501'/0'/0'", "evm:1": "m/44'/60'/0'/0/0", ... }
  CCTP_DOMAINS,                   // { "evm:1": 0, "evm:42161": 3, solana: 5, "evm:8453": 6, aptos: 9, ... }
  USDC_ASSETS,                    // { aptos: { chain, type, symbol, decimals, address }, solana: ..., "evm:1": ... }
  DEFAULT_CCTP_POLL_INTERVAL_MS,  // 2000
  DEFAULT_CCTP_TIMEOUT_MS,        // 1800000 (30 min)
} from "cow-wallet"
```
