# COW - COol Wallet

A multichain wallet library built on Effect TS. Supports **Aptos**, **Solana**, and **EVM** chains with **CCTP V2** cross-chain USDC transfers.

Two entry points: a **promise-based client** for app developers and an **Effect TS layer** for advanced composition.

```
pnpm add @wallet/core
```

## Quick Start

```typescript
import { createWalletClient } from "@wallet/core/client"

const wallet = createWalletClient({
  chains: [
    { chainId: "evm:1", kind: "evm", name: "Ethereum", rpcUrl: "https://eth.llamarpc.com", cctpDomain: 0, nativeAsset: { chain: "evm:1", type: "native", symbol: "ETH", decimals: 18 } },
    { chainId: "evm:8453", kind: "evm", name: "Base", rpcUrl: "https://mainnet.base.org", cctpDomain: 6, nativeAsset: { chain: "evm:8453", type: "native", symbol: "ETH", decimals: 18 } },
    { chainId: "solana", kind: "solana", name: "Solana", rpcUrl: "https://api.mainnet-beta.solana.com", cctpDomain: 5, nativeAsset: { chain: "solana", type: "native", symbol: "SOL", decimals: 9 } },
  ],
  cctp: {
    attestationApiUrl: "https://iris-api.circle.com/v2",
    contractAddresses: {
      "evm:1": { tokenMessenger: "0xbd3fa...", messageTransmitter: "0xc309...", usdcToken: "0xa0b8..." },
      "evm:8453": { tokenMessenger: "0x1682...", messageTransmitter: "0xaD09...", usdcToken: "0x833...", },
    },
    attestationPollIntervalMs: 2000,
    attestationTimeoutMs: 1800000,
  },
  auth: { elevatedThreshold: 100_000_000n, sessionTtlMs: 300_000, pinMinLength: 4 },
  keyring: {
    mnemonicStrength: 128,
    derivationPaths: {
      "evm:1": "m/44'/60'/0'/0/0",
      "evm:8453": "m/44'/60'/0'/0/0",
      solana: "m/44'/501'/0'/0'",
    },
  },
})

// Generate a wallet
const { mnemonic, keys } = await wallet.generate()
console.log("Seed phrase:", mnemonic.phrase)
console.log("Addresses:", keys.map(k => `${k.chain}: ${k.address}`))

// Check balances across all chains
const portfolio = await wallet.getPortfolio()

// Transfer USDC on the same chain
await wallet.transfer({
  from: { chain: "evm:1", address: keys[0].address },
  to: { chain: "evm:1", address: "0xrecipient..." },
  asset: { chain: "evm:1", type: "token", symbol: "USDC", decimals: 6, address: "0xa0b8..." },
  amount: 10_000_000n, // 10 USDC
})

// Cross-chain USDC via CCTP (Ethereum -> Base)
await wallet.transfer({
  from: { chain: "evm:1", address: keys[0].address },
  to: { chain: "evm:8453", address: keys[1].address },
  asset: { chain: "evm:1", type: "token", symbol: "USDC", decimals: 6, address: "0xa0b8..." },
  amount: 50_000_000n, // 50 USDC
})
```

## Core Concepts

### Chains

Every chain is identified by a `ChainId` string: `"aptos"`, `"solana"`, or `"evm:<numeric-chain-id>"`. You can run multiple EVM chains simultaneously (`"evm:1"`, `"evm:8453"`, `"evm:42161"`).

Each chain in your config needs:
- `chainId` and `kind` (`"evm"`, `"solana"`, `"aptos"`, or `"mock"` for testing)
- `rpcUrl` pointing to a JSON-RPC endpoint
- `nativeAsset` describing the chain's gas token
- `cctpDomain` (optional) for CCTP cross-chain support

### Accounts

One mnemonic seeds all chains. Each chain gets a BIP-44 derived key at account index 0 when you call `generate()` or `importMnemonic()`.

```typescript
// Create additional accounts on the same chain
const account1 = await wallet.addAccount("evm:1")   // m/44'/60'/1'/0/0
const account2 = await wallet.addAccount("evm:1")   // m/44'/60'/2'/0/0

// Import an external private key
const imported = await wallet.importPrivateKey("solana", privateKeyBytes)

// List everything
const allKeys = await wallet.listKeys()
// => [evm:1 (idx 0), evm:1 (idx 1), evm:1 (idx 2), solana (idx 0), solana (imported), ...]
```

### Transfers

`wallet.transfer(intent)` handles everything: balance check, routing, signing, broadcasting, and CCTP attestation polling.

- **Same-chain**: one direct transaction.
- **Cross-chain USDC**: burns on source chain, polls Circle for attestation (~2-15 min), mints on destination chain. All automatic.
- **Non-USDC cross-chain**: returns `UnsupportedRouteError` (CCTP only for now).

You can dry-run without executing:

```typescript
const plan = await wallet.planTransfer(intent)
console.log(plan.isCrossChain, plan.steps.map(s => s.type))
```

### Balances

```typescript
// Single asset
const bal = await wallet.getBalance("evm:1", address, usdcAsset)
console.log(bal.balance) // bigint in smallest unit

// All accounts, all chains
const portfolio = await wallet.getPortfolio()
portfolio.balances.forEach(b =>
  console.log(`${b.asset.chain} ${b.asset.symbol}: ${b.balance}`)
)
```

### Backup & Restore

```typescript
// Export encrypted bundle
const encKey = await wallet.deriveEncryptionKey() // from passkey/PIN
const bundle = await wallet.exportBackup(encKey)
// Save `bundle` (Uint8Array) to iCloud, Google Drive, file download, etc.

// Restore
const keys = await wallet.importBackup(bundle, encKey)
```

### Error Handling

Errors are thrown as plain objects with a `_tag` field:

```typescript
try {
  await wallet.transfer(intent)
} catch (e) {
  switch (e._tag) {
    case "InsufficientBalanceError":
      console.log(`Need ${e.required}, have ${e.available}`)
      break
    case "UnsupportedRouteError":
      console.log(`No route from ${e.from} to ${e.to} for ${e.asset}`)
      break
    case "AuthDeniedError":
      console.log(`User denied: ${e.reason}`)
      break
    case "CctpAttestationTimeout":
      // Can resume later with wallet.resumeCctpTransfer(id, recipient, destChain)
      break
  }
}
```

All error types: `KeyGenerationError`, `KeyNotFoundError`, `AuthDeniedError`, `AuthTimeoutError`, `InsufficientBalanceError`, `BroadcastError`, `FeeEstimationError`, `CctpAttestationTimeout`, `CctpMintError`, `UnsupportedChainError`, `UnsupportedRouteError`, `StorageError`, `BackupError`, `BackupDecryptionError`, `FetchError`.

## Production Setup

### Authentication

The default auth gate auto-approves everything (for development). Wire a real one for production:

**Browser (WebAuthn passkeys):**
```typescript
import { createWalletClient, makeWebAuthnAuthGate } from "@wallet/core"

const wallet = createWalletClient(config, {
  authGate: makeWebAuthnAuthGate({
    rpId: "wallet.example.com",
    credentialIds: [storedCredentialId],
    userVerification: "required",
  }),
})
```

**React Native / custom UI:**
```typescript
import { createWalletClient, makeCallbackAuthGate } from "@wallet/core"

const wallet = createWalletClient(config, {
  authGate: makeCallbackAuthGate({
    promptApproval: async (request) => {
      // Show your approval UI. Return AuthApproval on success, null to deny.
      const ok = await showApprovalSheet(request.reason, request.requiredLevel)
      return ok ? { method: "biometric", timestamp: Date.now() } : null
    },
    getEncryptionKey: async () => {
      // Derive from passkey/PIN for backup encryption
      return derivedKeyBytes
    },
    timeoutMs: 5 * 60_000,
  }),
})
```

### Storage

Default is in-memory (lost on refresh). For production:

```typescript
import { createWalletClient, makeSecureStorageAdapter } from "@wallet/core"

const wallet = createWalletClient(config, {
  storage: makeSecureStorageAdapter({
    save: (key, value) => SecureStore.setItemAsync(key, base64Encode(value)),
    load: async (key) => { const v = await SecureStore.getItemAsync(key); return v ? base64Decode(v) : null },
    delete: (key) => SecureStore.deleteItemAsync(key),
    list: (prefix) => myIndexedKeyLookup(prefix),
  }),
})
```

Or use the string-backed variant that handles base64 automatically:
```typescript
import { makeStringSecureStorageAdapter } from "@wallet/core"
```

### Backup Providers

```typescript
import { createWalletClient, iCloudBackupAdapter, googleDriveBackupAdapter } from "@wallet/core"

const wallet = createWalletClient(config, {
  backup: iCloudBackupAdapter({
    saveFile: (file, manifest) => NativeModules.ICloudKV.set("wallet.backup", base64Encode(file)),
    loadFile: async () => { const b64 = await NativeModules.ICloudKV.get("wallet.backup"); return b64 ? { file: base64Decode(b64) } : null },
    checkStatus: () => NativeModules.ICloudKV.getMetadata("wallet.backup"),
  }),
})
```

## Effect TS API

For power users who want full composition, streaming, custom retry policies, or test layer overrides:

```typescript
import { Effect } from "effect"
import { createWallet, KeyringService, TransferService, BalanceService } from "@wallet/core"

const layer = createWallet(config)

const program = Effect.gen(function* () {
  const keyring = yield* KeyringService
  const transfer = yield* TransferService
  const balance = yield* BalanceService

  const { keys } = yield* keyring.generate()
  const portfolio = yield* balance.getPortfolio(keys)

  const result = yield* transfer.execute({
    from: { chain: "evm:1", address: keys[0].address },
    to: { chain: "evm:8453", address: keys[0].address },
    asset: usdc,
    amount: 10_000_000n,
  })

  return result
})

await Effect.runPromise(Effect.provide(program, layer))
```

### Testing

All adapters are swappable via Effect's Layer system:

```typescript
import { createWallet, makeMockFetchAdapter, InMemoryStorageAdapter, TestAuthGate } from "@wallet/core"

const testLayer = createWallet(testConfig, {
  fetch: makeMockFetchAdapter({ handlers: [...], fallbackTo404: true }),
  storage: InMemoryStorageAdapter,
  authGate: TestAuthGate,
})
```

The test helpers at `@wallet/core/test` provide `makeTestHarness()` which pre-wires mock adapters and lets you seed balances:

```typescript
import { makeTestHarness } from "@wallet/core/test"

const { layer, seed } = makeTestHarness()
seed(address, usdcAsset, 100_000_000n)
// Run your Effect programs against `layer`
```

## Supported Chains

| Chain | Kind | Signing | CCTP | Status |
|-------|------|---------|------|--------|
| Ethereum | `evm` | secp256k1 (EIP-1559) | Yes | Production |
| Base | `evm` | secp256k1 (EIP-1559) | Yes | Production |
| Arbitrum | `evm` | secp256k1 (EIP-1559) | Yes | Production |
| Optimism | `evm` | secp256k1 (EIP-1559) | Yes | Production |
| Avalanche | `evm` | secp256k1 (EIP-1559) | Yes | Production |
| Solana | `solana` | ed25519 | Scaffolded | RPC + signing ready |
| Aptos | `aptos` | ed25519 | Scaffolded | Requires SDK client |

### EVM Chains

Any EVM chain works. Add it to `chains` with `kind: "evm"` and the right `chainId`:

```typescript
{ chainId: "evm:137", kind: "evm", name: "Polygon", rpcUrl: "https://polygon-rpc.com", ... }
```

EVM adapters use EIP-1559 fee estimation (with legacy fallback) and viem for transaction encoding.

### Aptos

Requires a caller-constructed `Aptos` client instance. Use `makeAptosAwareRegistryLive(aptosClients)` in the `chainRegistry` override:

```typescript
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk"
import { createWalletClient, makeAptosAwareRegistryLive } from "@wallet/core"

const aptosClient = new Aptos(new AptosConfig({ network: Network.MAINNET }))
const wallet = createWalletClient(config, {
  chainRegistry: makeAptosAwareRegistryLive(new Map([["aptos", aptosClient]])),
})
```

## Architecture

```
TransferService          ← top-level orchestrator
  |-- RouterService      ← intent -> plan (same-chain or CCTP)
  |-- SignerService      ← auth -> sign (keys never leave KeyringService)
  |-- BroadcastService   ← submit signed tx to chain
  |-- BalanceService     ← parallel balance queries
  |-- CctpService        ← burn/attest/mint lifecycle + resume

ChainAdapterRegistry     ← one adapter per configured chain
  |-- EvmChainAdapter    ← viem + JSON-RPC via FetchAdapter
  |-- SolanaChainAdapter ← @solana/web3.js + JSON-RPC via FetchAdapter
  |-- AptosChainAdapter  ← @aptos-labs/ts-sdk

KeyringService           ← BIP-39 mnemonic, BIP-44 derivation, signing
                            (private keys never leave this service)
```

All HTTP flows through an injected `FetchAdapter` -- no direct `fetch` calls, no Node.js APIs. The library runs in browsers, React Native, and Node.

## Defaults & Constants

```typescript
import {
  DEFAULT_DERIVATION_PATHS,  // BIP-44 paths per chain
  CCTP_DOMAINS,              // Circle domain IDs per chain
  USDC_ASSETS,               // Well-known USDC asset descriptors
} from "@wallet/core"
```

## License

MIT
