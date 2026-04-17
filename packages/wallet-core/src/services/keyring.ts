import { Context, Effect, Layer } from "effect"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { WalletConfigService } from "../config/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import type { AuthApproval } from "../model/auth.js"
import type { ChainId } from "../model/chain.js"
import type { DerivedKey, Mnemonic } from "../model/keyring.js"
import {
  AuthDeniedError,
  BackupDecryptionError,
  KeyGenerationError,
  KeyNotFoundError,
  StorageError,
} from "../model/errors.js"
import {
  aeadDecrypt,
  aeadEncrypt,
  curveFor,
  deriveAddressForChain,
  deriveKeypair,
  generateMnemonic,
  mnemonicIsValid,
  mnemonicToSeed,
  publicKeyForChain,
  randomBytes,
  signMessageForChain,
} from "./keyring-crypto.js"

/**
 * On-disk layout (via StorageAdapter):
 *
 *   keyring:mnemonic  -> BIP-39 mnemonic phrase (utf8 bytes)
 *   keyring:keys      -> JSON-encoded array of StoredDerivedKey entries
 *
 * Private keys live only transiently inside this service — they're
 * loaded, used for a single signing operation, then zeroed. The
 * signing flow exposed via `signBytes` returns only signatures; the
 * key bytes never cross the service boundary.
 */

interface StoredDerivedKey {
  readonly chain: ChainId
  readonly path: string
  readonly publicKeyHex: string
  readonly address: string
  readonly privateKeyHex: string
  /** True when the key came from `importPrivateKey`, not mnemonic derivation. */
  readonly imported?: boolean
}

const IMPORTED_PATH = "import"

const STORAGE_KEYS = {
  mnemonic: "keyring:mnemonic",
  keys: "keyring:keys",
} as const

export interface KeyringServiceShape {
  readonly generate: () => Effect.Effect<
    { mnemonic: Mnemonic; keys: readonly DerivedKey[] },
    KeyGenerationError | StorageError,
    StorageAdapter | WalletConfigService
  >

  readonly importMnemonic: (
    phrase: string,
  ) => Effect.Effect<
    readonly DerivedKey[],
    KeyGenerationError | StorageError,
    StorageAdapter | WalletConfigService
  >

  /**
   * Import a single raw private key for a specific chain. The chain
   * must be present in `WalletConfig.chains`. The stored key is
   * flagged so it survives `exportEncrypted` / `importEncrypted`
   * round-trips but is NOT re-derivable from the mnemonic — calling
   * `importMnemonic` afterwards overwrites every stored key with the
   * mnemonic-derived set, which will drop imported keys. This mirrors
   * how MetaMask / Phantom handle "imported accounts".
   *
   * Fails with `KeyGenerationError` if the chain is missing from
   * config, the private key length is wrong for the chain's curve, or
   * a key already exists for that chain and `overwrite` is not set.
   */
  readonly importPrivateKey: (
    chain: ChainId,
    privateKey: Uint8Array,
    options?: { readonly overwrite?: boolean },
  ) => Effect.Effect<
    DerivedKey,
    KeyGenerationError | StorageError,
    StorageAdapter | WalletConfigService
  >

  readonly getKey: (
    chain: ChainId,
  ) => Effect.Effect<DerivedKey, KeyNotFoundError | StorageError, StorageAdapter>

  readonly listKeys: () => Effect.Effect<
    readonly DerivedKey[],
    StorageError,
    StorageAdapter
  >

  /**
   * Sign the supplied bytes with the chain-appropriate curve and
   * return only the signature. The private key is loaded into a
   * transient buffer, used, and zeroed before this effect returns —
   * it is not visible to any service outside this layer.
   *
   *   - ed25519 chains (aptos, solana): `data` is the message bytes;
   *     the result is the 64-byte signature.
   *   - secp256k1 chains (evm:*): `data` is the 32-byte message digest;
   *     the result is 65 bytes = r || s || recovery.
   */
  readonly signBytes: (
    chain: ChainId,
    data: Uint8Array,
    authProof: AuthApproval,
  ) => Effect.Effect<
    Uint8Array,
    KeyNotFoundError | AuthDeniedError | StorageError,
    StorageAdapter
  >

  readonly exportEncrypted: (
    encryptionKey: Uint8Array,
  ) => Effect.Effect<Uint8Array, StorageError, StorageAdapter>

  readonly importEncrypted: (
    bundle: Uint8Array,
    encryptionKey: Uint8Array,
  ) => Effect.Effect<
    readonly DerivedKey[],
    BackupDecryptionError | KeyGenerationError | StorageError,
    StorageAdapter
  >
}

export class KeyringService extends Context.Tag("KeyringService")<
  KeyringService,
  KeyringServiceShape
>() {}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const loadStoredKeys = (
  storage: Context.Tag.Service<StorageAdapter>,
): Effect.Effect<readonly StoredDerivedKey[], StorageError> =>
  Effect.map(storage.load(STORAGE_KEYS.keys), (bytes) => {
    if (!bytes) return []
    return JSON.parse(textDecoder.decode(bytes)) as StoredDerivedKey[]
  })

const saveStoredKeys = (
  storage: Context.Tag.Service<StorageAdapter>,
  keys: readonly StoredDerivedKey[],
): Effect.Effect<void, StorageError> =>
  storage.save(STORAGE_KEYS.keys, textEncoder.encode(JSON.stringify(keys)))

const toDerivedKey = (stored: StoredDerivedKey): DerivedKey => ({
  chain: stored.chain,
  publicKey: hexToBytes(stored.publicKeyHex),
  address: stored.address,
  path: { chain: stored.chain, path: stored.path },
})

/**
 * Live KeyringService layer. Uses real crypto from @noble/@scure, BIP-39
 * mnemonics, BIP-32/SLIP-0010 derivation, and AES-GCM for at-rest encryption.
 */
export const KeyringServiceLive = Layer.succeed(
  KeyringService,
  {
    generate: () =>
      Effect.gen(function* () {
        const configService = yield* WalletConfigService
        const storage = yield* StorageAdapter
        const { mnemonicStrength, derivationPaths } = configService.config.keyring

        const phrase = generateMnemonic(mnemonicStrength)
        const seed = mnemonicToSeed(phrase)

        const stored: StoredDerivedKey[] = []
        for (const chain of configService.config.chains) {
          const path = derivationPaths[chain.chainId]
          if (!path) {
            return yield* Effect.fail(
              new KeyGenerationError({
                message: `No derivation path configured for chain ${String(chain.chainId)}`,
              }),
            )
          }
          try {
            const kp = deriveKeypair(String(chain.chainId), path, seed)
            stored.push({
              chain: chain.chainId,
              path,
              publicKeyHex: bytesToHex(kp.publicKey),
              address: kp.address,
              privateKeyHex: bytesToHex(kp.privateKey),
            })
          } catch (e) {
            return yield* Effect.fail(
              new KeyGenerationError({
                message: `Derivation failed for ${String(chain.chainId)}: ${
                  (e as Error).message
                }`,
              }),
            )
          }
        }

        yield* storage.save(STORAGE_KEYS.mnemonic, textEncoder.encode(phrase))
        yield* saveStoredKeys(storage, stored)

        const mnemonic: Mnemonic = {
          phrase,
          // `entropy` here carries the first 32 bytes of the BIP-39
          // seed rather than the raw mnemonic entropy — we never
          // expose the unprocessed entropy through the public API.
          entropy: seed.slice(0, 32),
        }
        const keys = stored.map(toDerivedKey)
        return { mnemonic, keys }
      }),

    importMnemonic: (phrase) =>
      Effect.gen(function* () {
        const configService = yield* WalletConfigService
        const storage = yield* StorageAdapter
        if (!mnemonicIsValid(phrase)) {
          return yield* Effect.fail(
            new KeyGenerationError({ message: "Invalid BIP-39 mnemonic" }),
          )
        }
        const seed = mnemonicToSeed(phrase)
        const stored: StoredDerivedKey[] = []
        for (const chain of configService.config.chains) {
          const path = configService.config.keyring.derivationPaths[chain.chainId]
          if (!path) {
            return yield* Effect.fail(
              new KeyGenerationError({
                message: `No derivation path configured for chain ${String(chain.chainId)}`,
              }),
            )
          }
          try {
            const kp = deriveKeypair(String(chain.chainId), path, seed)
            stored.push({
              chain: chain.chainId,
              path,
              publicKeyHex: bytesToHex(kp.publicKey),
              address: kp.address,
              privateKeyHex: bytesToHex(kp.privateKey),
            })
          } catch (e) {
            return yield* Effect.fail(
              new KeyGenerationError({
                message: `Derivation failed: ${(e as Error).message}`,
              }),
            )
          }
        }
        yield* storage.save(STORAGE_KEYS.mnemonic, textEncoder.encode(phrase))
        yield* saveStoredKeys(storage, stored)
        return stored.map(toDerivedKey)
      }),

    importPrivateKey: (chain, privateKey, options) =>
      Effect.gen(function* () {
        const configService = yield* WalletConfigService
        const storage = yield* StorageAdapter
        const chainConfig = configService.config.chains.find(
          (c) => c.chainId === chain,
        )
        if (!chainConfig) {
          return yield* Effect.fail(
            new KeyGenerationError({
              message: `Chain ${String(chain)} is not in WalletConfig.chains — add it before importing a key`,
            }),
          )
        }
        // Both supported curves use 32-byte private keys (ed25519 seed /
        // secp256k1 scalar). Reject anything else up-front so the caller
        // gets a clean error instead of a cryptic noble-curves stack.
        if (privateKey.length !== 32) {
          return yield* Effect.fail(
            new KeyGenerationError({
              message: `Private key must be 32 bytes, got ${privateKey.length}`,
            }),
          )
        }
        let publicKey: Uint8Array
        let address: string
        try {
          publicKey = publicKeyForChain(String(chain), privateKey)
          address = deriveAddressForChain(String(chain), publicKey)
        } catch (e) {
          return yield* Effect.fail(
            new KeyGenerationError({
              message: `Failed to derive address for ${String(chain)}: ${
                (e as Error).message
              }`,
            }),
          )
        }

        const existing = yield* loadStoredKeys(storage)
        if (existing.some((k) => k.chain === chain) && !options?.overwrite) {
          return yield* Effect.fail(
            new KeyGenerationError({
              message: `A key for ${String(chain)} already exists — pass { overwrite: true } to replace it`,
            }),
          )
        }
        const stored: StoredDerivedKey = {
          chain,
          path: IMPORTED_PATH,
          publicKeyHex: bytesToHex(publicKey),
          address,
          privateKeyHex: bytesToHex(privateKey),
          imported: true,
        }
        // Keep every other chain's key untouched; replace (or append)
        // only the entry for this chain.
        const next = existing
          .filter((k) => k.chain !== chain)
          .concat(stored)
        yield* saveStoredKeys(storage, next)
        // Curve check for sanity (matches what signBytes will expect).
        curveFor(String(chain))
        return toDerivedKey(stored)
      }),

    getKey: (chain) =>
      Effect.gen(function* () {
        const storage = yield* StorageAdapter
        const keys = yield* loadStoredKeys(storage)
        const found = keys.find((k) => k.chain === chain)
        if (!found) {
          return yield* Effect.fail(new KeyNotFoundError({ chain: String(chain) }))
        }
        return toDerivedKey(found)
      }),

    listKeys: () =>
      Effect.gen(function* () {
        const storage = yield* StorageAdapter
        const keys = yield* loadStoredKeys(storage)
        return keys.map(toDerivedKey)
      }),

    signBytes: (chain, data, authProof) =>
      Effect.gen(function* () {
        if (!authProof || !authProof.method) {
          return yield* Effect.fail(
            new AuthDeniedError({ reason: "no auth proof provided" }),
          )
        }
        const storage = yield* StorageAdapter
        const keys = yield* loadStoredKeys(storage)
        const found = keys.find((k) => k.chain === chain)
        if (!found) {
          return yield* Effect.fail(new KeyNotFoundError({ chain: String(chain) }))
        }
        // The private key is loaded into a transient local, used to
        // produce a curve-specific signature, then zeroed. Only the
        // signature leaves this service.
        const privateKey = hexToBytes(found.privateKeyHex)
        let signature: Uint8Array
        try {
          signature = signMessageForChain(String(chain), data, privateKey)
        } catch (e) {
          privateKey.fill(0)
          return yield* Effect.fail(
            new AuthDeniedError({
              reason: `signing failed for ${String(chain)}: ${(e as Error).message}`,
            }),
          )
        }
        privateKey.fill(0)
        return signature
      }),

    exportEncrypted: (encryptionKey) =>
      Effect.gen(function* () {
        const storage = yield* StorageAdapter
        const mnemonicBytes = yield* storage.load(STORAGE_KEYS.mnemonic)
        const keys = yield* loadStoredKeys(storage)
        const bundle = {
          version: 1,
          mnemonic: mnemonicBytes ? textDecoder.decode(mnemonicBytes) : null,
          keys,
        }
        const plaintext = textEncoder.encode(JSON.stringify(bundle))
        const nonce = randomBytes(12)
        const ciphertext = aeadEncrypt(encryptionKey, nonce, plaintext)
        // Prepend nonce to ciphertext so importer can recover it.
        const out = new Uint8Array(12 + ciphertext.length)
        out.set(nonce, 0)
        out.set(ciphertext, 12)
        return out
      }),

    importEncrypted: (bundle, encryptionKey) =>
      Effect.gen(function* () {
        if (bundle.length < 13) {
          return yield* Effect.fail(
            new BackupDecryptionError({ message: "bundle too short" }),
          )
        }
        const storage = yield* StorageAdapter
        const nonce = bundle.slice(0, 12)
        const ciphertext = bundle.slice(12)
        let plaintext: Uint8Array
        try {
          plaintext = aeadDecrypt(encryptionKey, nonce, ciphertext)
        } catch (e) {
          return yield* Effect.fail(
            new BackupDecryptionError({
              message: `AEAD decrypt failed: ${(e as Error).message}`,
            }),
          )
        }
        let parsed: { mnemonic: string | null; keys: StoredDerivedKey[] }
        try {
          parsed = JSON.parse(textDecoder.decode(plaintext))
        } catch (e) {
          return yield* Effect.fail(
            new BackupDecryptionError({
              message: `bundle parse failed: ${(e as Error).message}`,
            }),
          )
        }
        if (parsed.mnemonic) {
          yield* storage.save(
            STORAGE_KEYS.mnemonic,
            textEncoder.encode(parsed.mnemonic),
          )
        }
        yield* saveStoredKeys(storage, parsed.keys)
        return parsed.keys.map(toDerivedKey)
      }),
  },
)
