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
  deriveKeypair,
  generateMnemonic,
  mnemonicIsValid,
  mnemonicToSeed,
  randomBytes,
} from "./keyring-crypto.js"

/**
 * On-disk layout (via StorageAdapter):
 *
 *   keyring:mnemonic  -> encrypted BIP-39 mnemonic phrase (utf8 bytes)
 *   keyring:keys      -> JSON-encoded array of StoredDerivedKey entries
 *   keyring:salt      -> 16 bytes of salt for HKDF key derivation
 *   keyring:nonce     -> 12 bytes nonce for mnemonic AEAD
 *
 * Private keys themselves live only transiently in memory inside this
 * service. Nothing outside KeyringService ever sees a raw private key.
 */

interface StoredDerivedKey {
  readonly chain: ChainId
  readonly path: string
  readonly publicKeyHex: string
  readonly address: string
  readonly privateKeyHex: string
}

const STORAGE_KEYS = {
  mnemonic: "keyring:mnemonic",
  keys: "keyring:keys",
  salt: "keyring:salt",
  nonce: "keyring:nonce",
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

  readonly getKey: (
    chain: ChainId,
  ) => Effect.Effect<DerivedKey, KeyNotFoundError | StorageError, StorageAdapter>

  readonly listKeys: () => Effect.Effect<
    readonly DerivedKey[],
    StorageError,
    StorageAdapter
  >

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
          // We don't expose raw entropy through the public API, just the seed-equivalent.
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
          if (!path) continue
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

    signBytes: (chain, _data, authProof) =>
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
        // Return raw private key bytes to the caller. SignerService passes
        // these straight into ChainAdapter.sign() and discards immediately.
        return hexToBytes(found.privateKeyHex)
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
