import { HDKey } from "@scure/bip32"
import {
  generateMnemonic as scureGenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english"
import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { hkdf } from "@noble/hashes/hkdf"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { sha512 } from "@noble/hashes/sha512"
import { keccak_256, sha3_256 } from "@noble/hashes/sha3"
import { gcm } from "@noble/ciphers/aes"
import { bytesToHex } from "@noble/hashes/utils"

/**
 * Pure crypto helpers for the keyring. No Effect here — these are the
 * lowest-level primitives, wrapped in Effect by the service implementation.
 */

export interface ChainCurve {
  readonly curve: "ed25519" | "secp256k1"
}

export const curveFor = (chain: string): ChainCurve => {
  if (chain === "aptos" || chain === "solana") return { curve: "ed25519" }
  if (chain.startsWith("evm:")) return { curve: "secp256k1" }
  // Unknown / mock chains default to ed25519 — deterministic and cheap.
  return { curve: "ed25519" }
}

/**
 * BIP-39 mnemonic generation and validation.
 */
export const generateMnemonic = (strength: 128 | 256): string =>
  scureGenerateMnemonic(wordlist, strength)

export const mnemonicIsValid = (phrase: string): boolean =>
  validateMnemonic(phrase, wordlist)

export const mnemonicToSeed = (phrase: string): Uint8Array =>
  mnemonicToSeedSync(phrase)

/**
 * SLIP-0010 style ed25519 derivation for hardened paths (used by
 * Aptos and Solana). The @scure/bip32 HDKey only handles secp256k1;
 * for ed25519 we implement SLIP-0010 inline.
 */
const ED25519_CURVE = new TextEncoder().encode("ed25519 seed")

const hmacSha512 = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  hmac(sha512, key, data)

const parsePath = (path: string): number[] => {
  if (!path.startsWith("m/")) {
    throw new Error(`Invalid derivation path: ${path}`)
  }
  return path
    .slice(2)
    .split("/")
    .map((segment) => {
      const hardened = segment.endsWith("'")
      const num = parseInt(hardened ? segment.slice(0, -1) : segment, 10)
      if (Number.isNaN(num)) {
        throw new Error(`Invalid path segment: ${segment}`)
      }
      return hardened ? num + 0x80000000 : num
    })
}

const deriveEd25519 = (seed: Uint8Array, path: string): Uint8Array => {
  const indices = parsePath(path)
  let I = hmacSha512(ED25519_CURVE, seed)
  let IL = I.slice(0, 32)
  let IR = I.slice(32, 64)
  for (const idx of indices) {
    if (idx < 0x80000000) {
      throw new Error(`SLIP-0010 ed25519 requires hardened indices; got ${idx}`)
    }
    const data = new Uint8Array(1 + 32 + 4)
    data[0] = 0
    data.set(IL, 1)
    data[33] = (idx >>> 24) & 0xff
    data[34] = (idx >>> 16) & 0xff
    data[35] = (idx >>> 8) & 0xff
    data[36] = idx & 0xff
    I = hmacSha512(IR, data)
    IL = I.slice(0, 32)
    IR = I.slice(32, 64)
  }
  return IL
}

const deriveSecp256k1 = (seed: Uint8Array, path: string): Uint8Array => {
  const master = HDKey.fromMasterSeed(seed)
  const child = master.derive(path)
  if (!child.privateKey) {
    throw new Error(`secp256k1 derivation produced no private key for ${path}`)
  }
  return child.privateKey
}

export interface DerivedKeypair {
  readonly chain: string
  readonly path: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: string
}

/**
 * Derive a keypair for a chain from a mnemonic seed. Address is computed
 * with a chain-appropriate hashing scheme (ed25519 -> sha256, evm -> keccak).
 */
export const deriveKeypair = (
  chain: string,
  path: string,
  seed: Uint8Array,
): DerivedKeypair => {
  const { curve } = curveFor(chain)
  if (curve === "ed25519") {
    const privateKey = deriveEd25519(seed, path)
    const publicKey = ed25519.getPublicKey(privateKey)
    const address = deriveAddressForChain(chain, publicKey)
    return { chain, path, privateKey, publicKey, address }
  }
  // secp256k1 (EVM)
  const privateKey = deriveSecp256k1(seed, path)
  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1) // strip 0x04 prefix
  const address = deriveAddressForChain(chain, publicKey)
  return { chain, path, privateKey, publicKey, address }
}

const deriveAddressForChain = (chain: string, publicKey: Uint8Array): string => {
  if (chain === "aptos") {
    // Aptos AuthenticationKey = sha3_256(pubkey || scheme_byte).
    // scheme_byte = 0x00 for single-signer Ed25519.
    const data = new Uint8Array(publicKey.length + 1)
    data.set(publicKey, 0)
    data[publicKey.length] = 0x00
    return "0x" + bytesToHex(sha3_256(data))
  }
  if (chain === "solana") {
    // Solana addresses are base58(pubkey).
    return base58Encode(publicKey)
  }
  if (chain.startsWith("evm:")) {
    // EVM address = last 20 bytes of keccak256(uncompressed pubkey).
    const hash = keccak_256(publicKey)
    return "0x" + bytesToHex(hash.slice(12))
  }
  // Default: deterministic hex prefix, matches mock adapter shape.
  return `${chain}:${bytesToHex(sha256(publicKey)).slice(0, 40)}`
}

// --- Base58 (Bitcoin alphabet) -----------------------------------------
// Used for Solana addresses. Tiny, no deps.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export const base58Encode = (bytes: Uint8Array): string => {
  if (bytes.length === 0) return ""
  let num = 0n
  for (const b of bytes) num = num * 256n + BigInt(b)
  let str = ""
  while (num > 0n) {
    const rem = num % 58n
    num = num / 58n
    str = BASE58_ALPHABET[Number(rem)] + str
  }
  // Preserve leading zero bytes as "1" characters.
  for (const b of bytes) {
    if (b === 0) str = "1" + str
    else break
  }
  return str
}

export const base58Decode = (s: string): Uint8Array => {
  if (s.length === 0) return new Uint8Array(0)
  let num = 0n
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`)
    num = num * 58n + BigInt(idx)
  }
  const bytes: number[] = []
  while (num > 0n) {
    bytes.unshift(Number(num % 256n))
    num = num / 256n
  }
  // Add back leading zero bytes (each "1" in prefix).
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0)
    else break
  }
  return new Uint8Array(bytes)
}

/**
 * Derive a 256-bit symmetric encryption key from a password/PIN + salt
 * using HKDF-SHA256. The salt should be persisted alongside ciphertexts.
 */
export const deriveEncryptionKey = (
  passwordBytes: Uint8Array,
  salt: Uint8Array,
): Uint8Array => hkdf(sha256, passwordBytes, salt, "wallet-core/aead", 32)

/**
 * AES-256-GCM AEAD encrypt/decrypt. nonce must be 12 bytes.
 */
export const aeadEncrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array => gcm(key, nonce).encrypt(plaintext)

export const aeadDecrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array => gcm(key, nonce).decrypt(ciphertext)

/**
 * Generate cryptographically-secure random bytes via Web Crypto.
 * Works in browsers, React Native, modern Node.
 */
export const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoObj: Crypto | undefined = (globalThis as any).crypto
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
    throw new Error("Web Crypto API unavailable: globalThis.crypto.getRandomValues missing")
  }
  cryptoObj.getRandomValues(out)
  return out
}

/**
 * Sign a message with the curve-appropriate algorithm for a chain. Used
 * internally by KeyringService so that private keys never leave the
 * service. Chain adapters produce the input bytes via
 * `buildSigningMessage` and receive the resulting signature via
 * `attachSignature`.
 *
 *   - ed25519 (aptos, solana): signs the raw message; returns 64 bytes.
 *   - secp256k1 (evm:*):        signs a 32-byte message digest; returns
 *     65 bytes = r (32) || s (32) || recovery (1).
 */
export const signMessageForChain = (
  chain: string,
  message: Uint8Array,
  privateKey: Uint8Array,
): Uint8Array => {
  const { curve } = curveFor(chain)
  if (curve === "ed25519") {
    return ed25519.sign(message, privateKey)
  }
  // secp256k1: must be a 32-byte message digest.
  if (message.length !== 32) {
    throw new Error(
      `secp256k1 signing requires a 32-byte digest, got ${message.length} bytes`,
    )
  }
  const sig = secp256k1.sign(message, privateKey)
  const compact = sig.toCompactRawBytes()
  const out = new Uint8Array(65)
  out.set(compact, 0)
  out[64] = sig.recovery ?? 0
  return out
}

/**
 * Derive the public key for a chain from a raw private key. Used by
 * SignerService alongside `signMessageForChain` so ChainAdapter
 * `attachSignature` always has a public key to build authenticators from.
 */
export const publicKeyForChain = (
  chain: string,
  privateKey: Uint8Array,
): Uint8Array => {
  const { curve } = curveFor(chain)
  if (curve === "ed25519") {
    return ed25519.getPublicKey(privateKey)
  }
  // secp256k1 uncompressed without the 0x04 prefix (64 bytes) — matches
  // what EVM address derivation expects.
  return secp256k1.getPublicKey(privateKey, false).slice(1)
}
