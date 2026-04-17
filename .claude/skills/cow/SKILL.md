---
name: cow
description: "Write correct code against the COW (COol Wallet) multichain wallet library. Use when building wallet features: key generation, balance queries, transfers (same-chain and cross-chain CCTP), arbitrary contract calls (sendCall / buildCall / simulateCall), backup/restore, auth gates, or adapter wiring. Covers both the promise API (createWalletClient) and the Effect TS API (createWallet)."
when_to_use: "wallet integration, key generation, mnemonic import, private key import, balance check, portfolio query, same-chain transfer, cross-chain USDC transfer, CCTP, arbitrary contract call, entry function, program invocation, sendCall, buildCall, simulateCall, backup, restore, auth gate, secure storage, signing, broadcasting, multi-account"
argument-hint: "[feature or question]"
allowed-tools: Read Grep Bash(pnpm *) Bash(node *)
---

# COW (COol Wallet) — Coding Skill

COW is the multichain wallet library published as `cow-wallet` on npm (source at `packages/wallet-core`). It supports **Aptos**, **Solana**, and **EVM** chains with **CCTP V1/V2** cross-chain USDC transfers.

## Installed version

```!
cat packages/wallet-core/package.json | grep '"version"' 2>/dev/null || echo "unknown"
```

## Two APIs — always prefer the promise one

### Promise API (default for app code)

```typescript
import { createWalletClient } from "cow-wallet/client"

const wallet = createWalletClient(config)
const { mnemonic, keys } = await wallet.generate()
```

### Effect API (only for test harnesses / custom Layer composition)

```typescript
import { createWallet, KeyringService } from "cow-wallet"
import { Effect } from "effect"

const layer = createWallet(config)
const program = Effect.gen(function* () {
  const keyring = yield* KeyringService
  return yield* keyring.generate()
})
await Effect.runPromise(Effect.provide(program, layer))
```

**Rule: always use `createWalletClient` unless the task explicitly requires Effect composition or test Layer overrides.**

## Minimal WalletConfig

Only `chains` is required. `cctp`, `auth`, and `keyring` all have sensible defaults and can be omitted or partially overridden:

```typescript
const config: WalletConfig = {
  chains: [
    {
      chainId: "evm:1",        // "aptos" | "solana" | "evm:<number>"
      kind: "evm",             // "evm" | "solana" | "aptos" | "mock"
      name: "Ethereum",
      rpcUrl: "https://eth-rpc.example.com",
      cctpDomain: 0,           // Circle CCTP domain (optional)
      nativeAsset: { chain: "evm:1", type: "native", symbol: "ETH", decimals: 18 },
    },
  ],
  cctp: {
    attestationApiUrl: "https://iris-api.circle.com/v2",
    contractAddresses: { /* per-chain tokenMessenger, messageTransmitter, usdcToken */ },
    attestationPollIntervalMs: 2000,
    attestationTimeoutMs: 1800000,
  },
  auth: {
    elevatedThreshold: 100_000_000n,
    sessionTtlMs: 300_000,
    pinMinLength: 4,
  },
  keyring: {
    mnemonicStrength: 128,     // 128 = 12 words, 256 = 24 words
    derivationPaths: { "evm:1": "m/44'/60'/0'/0/0" },
  },
}
```

## WalletClient method reference

```typescript
// Keyring
wallet.generate()                                    // -> { mnemonic, keys }
wallet.importMnemonic(phrase)                         // -> keys[]
wallet.importPrivateKey(chain, pkBytes, { overwrite?, accountIndex? })  // -> DerivedKey
wallet.addAccount(chain)                              // -> DerivedKey (next BIP-44 index)
wallet.getKey(chain, address?)                        // -> DerivedKey
wallet.listKeys()                                     // -> DerivedKey[]

// Balances
wallet.getBalance(chain, address, asset)              // -> TokenBalance
wallet.getPortfolio()                                 // -> Portfolio (auto-lists all keys)
wallet.getPortfolio(keys)                             // -> Portfolio (specific keys)

// Transfers
wallet.transfer(intent)                               // -> TransferResult
wallet.planTransfer(intent)                           // -> TransferPlan (dry-run)

// Low-level
wallet.sign(unsignedTx)                               // -> SignedTx
wallet.broadcast(signedTx)                            // -> TxReceipt

// Arbitrary contract / program / entry-function calls
wallet.buildCall(req)                                  // -> UnsignedTx (no sign)
wallet.sendCall(req)                                   // -> TxReceipt (build + sign + broadcast)
wallet.simulateCall(req)                               // -> CallSimulation (dry-run)

// CCTP resume (after app restart mid-transfer)
wallet.listPendingTransfers()                          // -> PendingCctpTransfer[]
wallet.resumeTransfer(id)                              // -> ResumeResult (reads recipient/destChain from record)
wallet.resumeTransfer(id, recipient, destChain)        // -> ResumeResult (explicit override)

// Sessions (multi-tx flows — approve once, sign many)
wallet.approveSession(reason, level?)                  // -> AuthApproval (prompts once)
wallet.endSession()                                    // -> void
wallet.hasActiveSession()                              // -> boolean

// Backup
wallet.exportBackup(encryptionKey)                    // -> Uint8Array
wallet.importBackup(bundle, encryptionKey)            // -> DerivedKey[]
wallet.deriveEncryptionKey()                          // -> Uint8Array

// Utilities
wallet.parseUnits("10.5", 6)                          // -> 10_500_000n
wallet.formatUnits(10_500_000n, 6)                    // -> "10.5"
wallet.asset("USDC", "evm:1")                         // -> AssetId | undefined
wallet.dispose()                                      // -> void (cleanup)

// Escape hatch
wallet.layer                                          // -> WalletLayer (Effect)
```

## Copy-paste patterns

### Generate wallet

```typescript
const wallet = createWalletClient(config)
const { mnemonic, keys } = await wallet.generate()
// mnemonic.phrase = "word1 word2 ..."
// keys = [{ chain, address, publicKey, accountIndex, path }]
```

### Import mnemonic

```typescript
const keys = await wallet.importMnemonic("abandon abandon abandon ...")
```

### Multiple accounts on one chain

```typescript
await wallet.generate()
const acct1 = await wallet.addAccount("evm:1")  // index 1
const acct2 = await wallet.addAccount("evm:1")  // index 2
const all = await wallet.listKeys()
```

### Check balance

```typescript
const usdc: AssetId = {
  chain: "evm:1", type: "token", symbol: "USDC", decimals: 6,
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
}
const bal = await wallet.getBalance("evm:1", address, usdc)
// bal.balance is bigint in smallest unit (1_000_000n = 1 USDC)
```

### Portfolio across all chains

```typescript
const portfolio = await wallet.getPortfolio()
```

### Same-chain transfer

```typescript
await wallet.transfer({
  from: { chain: "evm:1", address: senderAddr },
  to: { chain: "evm:1", address: recipientAddr },
  asset: usdc,
  amount: 10_000_000n,
})
```

### Cross-chain USDC (CCTP)

```typescript
await wallet.transfer({
  from: { chain: "evm:1", address: senderAddr },
  to: { chain: "evm:8453", address: recipientOnBase },
  asset: usdc,
  amount: 50_000_000n,
})
// burn -> poll attestation -> mint, all automatic
```

### Arbitrary contract / program / entry-function calls

Use `sendCall` / `buildCall` / `simulateCall` for anything beyond native / USDC transfers. They reuse the same key-isolated signing, auth gate, session, elevated-fee, and broadcast pipeline — so every guarantee from `transfer()` applies.

`CallRequest` is a discriminated union — one variant per chain kind:

```typescript
type CallRequest = EvmCallRequest | SolanaCallRequest | AptosCallRequest
```

#### EVM — contract interaction

```typescript
import { encodeFunctionData } from "viem"

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
  value: 0n,                // optional, default 0n
  label: "Approve USDC",    // shown in auth prompt + stored as metadata.intent
  // optional overrides — any omitted field is estimated via RPC:
  // gas, maxFeePerGas, maxPriorityFeePerGas, gasPrice, nonce
})
```

#### Solana — arbitrary program invocation

```typescript
const receipt = await wallet.sendCall({
  kind: "solana",
  chain: "solana",
  from: solKey.address,
  instructions: [
    {
      programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      keys: [{ pubkey: solKey.address, isSigner: true, isWritable: false }],
      data: new TextEncoder().encode("hello"),
    },
  ],
  label: "Post memo",
})
```

You can attach multiple instructions in one tx. Keys use base58 pubkeys; data is raw program-specific bytes.

#### Aptos — entry function

```typescript
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

#### Build without signing

```typescript
const tx = await wallet.buildCall(req)   // UnsignedTx — inspect fee, metadata
const signed = await wallet.sign(tx)     // goes through auth gate + keyring
const receipt = await wallet.broadcast(signed)
```

#### Simulate (dry-run, no signing)

```typescript
const sim = await wallet.simulateCall(req)
// EVM:    { success, returnData?, revertReason?, raw? }   // via eth_call
// Solana: { success, gasUsed?, logs?, revertReason?, raw? } // via simulateTransaction
// Aptos:  { success, gasUsed?, revertReason?, raw? }     // via simulate.simple
if (!sim.success) throw new Error(sim.revertReason)
```

#### Sessions apply identically

```typescript
await wallet.approveSession("Interact with Uniswap")
await wallet.sendCall({ kind: "evm", chain: "evm:1", from, to: router, data: swap1 })
await wallet.sendCall({ kind: "evm", chain: "evm:1", from, to: router, data: swap2 })
await wallet.endSession()
```

### Auth session for multi-tx flow

```typescript
await wallet.approveSession("Batch transfer to 5 recipients")
for (const intent of intents) {
  await wallet.transfer(intent)  // auto-approved
}
await wallet.endSession()
```

Sessions span CCTP cross-chain too (burn + attestation wait + mint all signed under one session). Default TTL: `auth.sessionTtlMs`. `"elevated"` (default) covers all request levels.

### Resume interrupted CCTP transfers on app startup

```typescript
const pending = await wallet.listPendingTransfers()
for (const t of pending) {
  if (t.status !== "completed" && t.status !== "failed") {
    await wallet.resumeTransfer(t.id) // reads recipient/destChain from record
  }
}
```

### Backup + restore

```typescript
const encKey = await wallet.deriveEncryptionKey()
const bundle = await wallet.exportBackup(encKey)
// later:
const keys = await wallet.importBackup(bundle, encKey)
```

## Error handling

All errors have a `_tag` discriminator:

```typescript
try {
  await wallet.transfer(intent)
} catch (e) {
  switch (e._tag) {
    case "InsufficientBalanceError":  // e.chain, e.required, e.available
    case "UnsupportedRouteError":     // e.from, e.to, e.asset
    case "AuthDeniedError":           // e.reason
    case "AuthTimeoutError":          // e.reason
    case "CctpAttestationTimeout":    // e.burnTxHash, e.elapsedMs
    case "KeyNotFoundError":          // e.chain, e.address
    case "BroadcastError":            // e.chain, e.hash, e.cause
    case "UnsupportedChainError":     // e.chain
    case "FeeEstimationError":        // e.chain, e.cause
    case "KeyGenerationError":        // e.message
    case "StorageError":              // e.operation, e.key, e.cause
    case "BackupError":               // e.provider, e.operation, e.cause
    case "BackupDecryptionError":     // e.message
    case "FetchError":                // e.url, e.status, e.cause
  }
}
```

## Production adapter overrides

Pass as second arg to `createWalletClient(config, overrides)`:

### Auth (default auto-approves — MUST override for prod)

```typescript
import { makeCallbackAuthGate } from "cow-wallet"

createWalletClient(config, {
  authGate: makeCallbackAuthGate({
    promptApproval: async (req) => {
      // req.reason, req.requiredLevel ("standard" | "elevated")
      // Return { method: "biometric", timestamp: Date.now() } or null
    },
    getEncryptionKey: async () => keyBytes,
  }),
})
```

Browser passkeys: `makeWebAuthnAuthGate({ rpId, credentialIds })`

### Storage (default in-memory — MUST override for prod)

```typescript
import { makeSecureStorageAdapter } from "cow-wallet"

createWalletClient(config, {
  storage: makeSecureStorageAdapter({
    save: (key, value) => secureStore.set(key, value),
    load: (key) => secureStore.get(key),
    delete: (key) => secureStore.delete(key),
    list: (prefix) => secureStore.keys(prefix),
  }),
})
```

### Backup

```typescript
import { iCloudBackupAdapter, googleDriveBackupAdapter } from "cow-wallet"

createWalletClient(config, {
  backup: iCloudBackupAdapter({ saveFile, loadFile, checkStatus }),
})
```

## Routing rules

```
same chain        -> 1 direct-transfer step
cross-chain USDC  -> cctp-burn + cctp-mint (auto attestation)
cross-chain other -> UnsupportedRouteError
```

## Critical constraints

- **Amounts are always `bigint`** in smallest unit: `1_000_000n` = 1 USDC, `1_000_000_000_000_000_000n` = 1 ETH
- **Private keys never leave `KeyringService`** — only signatures cross the boundary
- **All HTTP goes through `FetchAdapter`** — never call `fetch` directly
- **Browser/RN safe** — no Node.js APIs, no `Buffer`, uses `Uint8Array` + `globalThis.crypto`
- **`importMnemonic` overwrites all keys** — imported private keys are dropped (MetaMask behavior)
- **CCTP only for USDC** — non-USDC cross-chain throws `UnsupportedRouteError`

## Built-in constants

```typescript
import {
  DEFAULT_DERIVATION_PATHS,       // BIP-44 paths per chain
  CCTP_DOMAINS,                   // Circle domain IDs
  USDC_ASSETS,                    // Well-known USDC descriptors
  DEFAULT_CCTP_POLL_INTERVAL_MS,  // 2000
  DEFAULT_CCTP_TIMEOUT_MS,        // 1800000
} from "cow-wallet"
```

## Full API reference

For complete type signatures, see [api-reference.md](api-reference.md).

## Task

$ARGUMENTS
