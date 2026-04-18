# cow-wallet

Multichain wallet library for **Aptos**, **Solana**, and **EVM** chains. Supports native + token transfers, **CCTP V1/V2** cross-chain USDC, and **arbitrary contract calls** — all behind a single promise-based API with keyring-isolated signing, auth-gate prompts, session reuse, and pluggable secure storage.

Built on Effect TS internally; zero Effect knowledge required for application code.

## Install

```bash
pnpm add cow-wallet
# or
npm install cow-wallet
```

## Quick start

```ts
import { createWalletClient } from "cow-wallet/client"

const wallet = createWalletClient({
  chains: [
    {
      chainId: "evm:1",
      kind: "evm",
      name: "Ethereum",
      rpcUrl: "https://eth.llamarpc.com",
      nativeAsset: {
        chain: "evm:1", type: "native", symbol: "ETH", decimals: 18,
      },
    },
  ],
})

const { mnemonic, keys } = await wallet.generate()
const portfolio = await wallet.getPortfolio()
```

Only `chains` is required; `cctp`, `auth`, and `keyring` get sensible defaults.

## What you can do

### Transfer (native + tokens, same-chain)

```ts
await wallet.transfer({
  from: { chain: "evm:1", address: srcAddr },
  to:   { chain: "evm:1", address: recipientAddr },
  asset: wallet.asset("USDC", "evm:1")!,
  amount: 10_000_000n, // 10 USDC
})
```

### Cross-chain USDC (CCTP)

```ts
await wallet.transfer({
  from: { chain: "evm:1",    address: srcAddr },
  to:   { chain: "evm:8453", address: recipientOnBase },
  asset: wallet.asset("USDC", "evm:1")!,
  amount: 50_000_000n,
})
// burn → poll Circle attestation → mint — all automatic
```

If the app closes mid-transfer, resume on restart:

```ts
const pending = await wallet.listPendingTransfers()
for (const t of pending) await wallet.resumeTransfer(t.id)
```

#### Receiving USDC on Aptos (CCTP V1)

Aptos is CCTP V1-only until Circle ships V2 there (H1 2026). Burns from
Ethereum/Arbitrum/Base/etc. destined for Aptos must use the **V1**
`TokenMessenger` on the source chain — set `version: "v1"` on that chain's
`CctpContractAddresses`. The library ships Circle's compiled Move scripts
for Aptos mainnet (`handle_receive_message.mv`, `deposit_for_burn.mv`,
`deposit_for_burn_with_caller.mv`) so the mint-on-Aptos leg works out of the
box via `makeAptosAwareRegistryLive`:

```ts
import {
  createWalletClient,
  makeAptosAwareRegistryLive,
  APTOS_CCTP_V1_MAINNET,   // bundled bytecode + USDC metadata
} from "cow-wallet"
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk"

const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }))
const aptosClients = new Map([["aptos", aptos]])

const wallet = await createWalletClient({
  chains: [
    { chainId: "aptos", kind: "aptos", name: "Aptos", rpcUrl: "...", cctpDomain: 9, nativeAsset: { chain: "aptos", type: "native", symbol: "APT", decimals: 8 } },
    { chainId: "evm:1", kind: "evm",   name: "Ethereum", rpcUrl: "...", cctpDomain: 0, nativeAsset: { chain: "evm:1", type: "native", symbol: "ETH", decimals: 18 } },
  ],
  cctp: {
    contractAddresses: {
      "evm:1": {
        tokenMessenger:     "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
        messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
        usdcToken:          "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        version: "v1",    // required — V2 messages can't mint on Aptos
      },
      // Aptos entry is optional: omit it to use APTOS_CCTP_V1_MAINNET
      // automatically, or pass APTOS_CCTP_V1_TESTNET (re-exported) for
      // testnet. Supply your own entry only if you're pinning a custom
      // USDC address or re-compiled scripts.
    },
  },
}, {
  chainRegistry: makeAptosAwareRegistryLive(aptosClients),
})

await wallet.transfer({
  from: { chain: "evm:1", address: evmKey.address },
  to:   { chain: "aptos", address: aptKey.address },
  asset: wallet.asset("USDC", "evm:1")!,
  amount: 25_000_000n,
})
```

The mint submits a single Move script transaction that atomically chains
`message_transmitter::receive_message` →
`token_messenger_minter::handle_receive_message` →
`message_transmitter::complete_receive_message`. The recipient pays APT gas
by default; wire a `GasStationTransactionSubmitter` into `aptosClient` and
pass the chain id to `makeAptosAwareRegistryLive(aptosClients, sponsored)`
to sponsor it.

### Arbitrary contract / program / entry-function calls

For anything beyond transfers — contract interactions, program invocations, entry functions — use `sendCall` / `buildCall` / `simulateCall`. They reuse the exact same signing pipeline as `transfer()`, so auth-gate prompts, sessions, and elevated-fee escalation all apply identically.

**EVM**

```ts
import { encodeFunctionData } from "viem"

const data = encodeFunctionData({
  abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
          inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
          outputs: [{ type: "bool" }] }] as const,
  functionName: "approve",
  args: [router, 10_000_000n],
})

const receipt = await wallet.sendCall({
  kind: "evm",
  chain: "evm:1",
  from: evmKey.address,
  to: usdcAddress,
  data,
  value: 0n,
  label: "Approve USDC for Router",
})
```

**Solana**

```ts
await wallet.sendCall({
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

**Aptos**

```ts
await wallet.sendCall({
  kind: "aptos",
  chain: "aptos",
  from: aptKey.address,
  function: "0x1::coin::transfer",
  typeArguments: ["0x1::aptos_coin::AptosCoin"],
  functionArguments: [recipient, "1000"],
})
```

Three methods share the same `CallRequest`:

- `wallet.buildCall(req)` → `UnsignedTx` (build without signing)
- `wallet.sendCall(req)` → `TxReceipt` (build + sign + broadcast)
- `wallet.simulateCall(req)` → `{ success, returnData?, revertReason?, gasUsed?, logs?, raw? }` (dry-run)

### Sessions (approve once, sign many)

```ts
await wallet.approveSession("Batch operations")
await wallet.transfer(intent1)
await wallet.sendCall(callReq)
await wallet.transfer(intent2)
await wallet.endSession()
```

Sessions span CCTP cross-chain transfers — burn and mint are signed within one session even across minutes of attestation waiting.

### Keys, balances, backup

```ts
// Multiple accounts on one chain (BIP-44 derivation)
const acct1 = await wallet.addAccount("evm:1")
const acct2 = await wallet.addAccount("evm:1")

// Import an external private key
await wallet.importPrivateKey("solana", privateKeyBytes)

// Encrypted backup
const encKey = await wallet.deriveEncryptionKey()
const bundle = await wallet.exportBackup(encKey)
// later:
const keys = await wallet.importBackup(bundle, encKey)
```

### Error handling

All errors have a `_tag` discriminator:

```ts
try {
  await wallet.transfer(intent)
} catch (e) {
  if (e._tag === "InsufficientBalanceError") { /* e.required, e.available */ }
  if (e._tag === "AuthDeniedError")          { /* e.reason */ }
  if (e._tag === "CctpAttestationTimeout")   { /* resume via wallet.resumeTransfer(id) */ }
}
```

Full error list: `KeyGenerationError`, `KeyNotFoundError`, `AuthDeniedError`, `AuthTimeoutError`, `InsufficientBalanceError`, `BroadcastError`, `FeeEstimationError`, `CctpAttestationTimeout`, `CctpMintError`, `UnsupportedChainError`, `UnsupportedRouteError`, `StorageError`, `BackupError`, `BackupDecryptionError`, `FetchError`.

## Production setup

The library warns on startup if you're using dangerous defaults:

- `[cow] No storage adapter provided` — keys are in-memory, lost on refresh.
- `[cow] No auth gate provided` — every transaction auto-approves without user confirmation.

Wire production adapters to silence these:

```ts
import {
  createWalletClient,
  makeWebAuthnAuthGate,
  makeSecureStorageAdapter,
  iCloudBackupAdapter,
} from "cow-wallet"

const wallet = createWalletClient(config, {
  authGate: makeWebAuthnAuthGate({
    rpId: "wallet.example.com",
    credentialIds: [storedCredentialId],
    userVerification: "required",
  }),
  storage: makeSecureStorageAdapter({
    save:   (key, value) => secureStore.set(key, value),
    load:   (key)        => secureStore.get(key),
    delete: (key)        => secureStore.delete(key),
    list:   (prefix)     => secureStore.keys(prefix),
  }),
  backup: iCloudBackupAdapter({ saveFile, loadFile, checkStatus }),
})
```

React Native / custom UI use `makeCallbackAuthGate({ promptApproval, getEncryptionKey })`.

## Effect TS API

For callers who want full composition, streaming, or custom Layer overrides:

```ts
import { Effect } from "effect"
import { createWallet, KeyringService, TransferService, CallService } from "cow-wallet"

const layer = createWallet(config)

const program = Effect.gen(function* () {
  const keyring  = yield* KeyringService
  const transfer = yield* TransferService
  const calls    = yield* CallService

  const { keys } = yield* keyring.generate()
  yield* transfer.execute(intent)
  yield* calls.execute(callReq)
})

await Effect.runPromise(Effect.provide(program, layer))
```

All adapters are swappable via the Layer system, which makes testing trivial — see `cow-wallet/test` for helpers.

## Supported chains

| Chain     | Kind     | Signing            | CCTP | Status                 |
|-----------|----------|--------------------|------|------------------------|
| Ethereum  | `evm`    | secp256k1 / 1559   | V2   | Production             |
| Base      | `evm`    | secp256k1 / 1559   | V2   | Production             |
| Arbitrum  | `evm`    | secp256k1 / 1559   | V2   | Production             |
| Optimism  | `evm`    | secp256k1 / 1559   | V2   | Production             |
| Avalanche | `evm`    | secp256k1 / 1559   | V2   | Production             |
| Solana    | `solana` | ed25519            | V1 (scaffolded) | RPC + signing ready |
| Aptos     | `aptos`  | ed25519            | V1 (burn + mint) | Requires SDK client |

Any EVM chain works — just add an entry to `chains` with `kind: "evm"` and the right `chainId: "evm:<numeric-id>"`. Aptos requires a caller-constructed `Aptos` client wired in via `makeAptosAwareRegistryLive`. Aptos Gas Station sponsored transactions are supported via the SDK's `TRANSACTION_SUBMITTER` plugin.

## Architecture (one-liner)

```
TransferService / CallService
  → RouterService → SignerService (auth gate → keyring)
    → ChainAdapter (viem / @solana/web3.js / @aptos-labs/ts-sdk)
      → BroadcastService
```

Private keys never leave `KeyringService`. All HTTP flows through an injected `FetchAdapter` — no direct `fetch`, no Node.js APIs, no `Buffer`. Works in browsers, React Native, and Node.

## Links

- Source: https://github.com/porkytheblack/cow
- Full guide: [`guides/COW_AGENT_SKILL.md`](https://github.com/porkytheblack/cow/blob/main/guides/COW_AGENT_SKILL.md)
- Architecture doc: [`guides/ARCHITECTURE.md`](https://github.com/porkytheblack/cow/blob/main/guides/ARCHITECTURE.md)

## License

MIT
