import type { ChainId } from "./chain.js"

export interface Mnemonic {
  readonly phrase: string
  readonly entropy: Uint8Array
}

export interface DerivationPath {
  readonly chain: ChainId
  readonly path: string
}

export interface DerivedKey {
  readonly chain: ChainId
  readonly publicKey: Uint8Array
  readonly address: string
  readonly path: DerivationPath
}

/**
 * Private keys never leave KeyringService. This shape is internal only
 * and is used when serialising to encrypted storage.
 */
export interface StoredKeypair {
  readonly derivedKey: DerivedKey
  /** AEAD ciphertext of the raw private key, keyed by an auth-derived material. */
  readonly encryptedPrivateKey: Uint8Array
  readonly nonce: Uint8Array
}
