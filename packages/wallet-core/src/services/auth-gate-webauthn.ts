import { Layer } from "effect"
import { sha256 } from "@noble/hashes/sha256"
import type { AuthApproval, AuthRequest } from "../model/auth.js"
import { AuthDeniedError } from "../model/errors.js"
import type { AuthGateService } from "./auth-gate.js"
import {
  makeCallbackAuthGate,
  deriveEncryptionKeyFromSecret,
} from "./auth-gate-callback.js"

/**
 * WebAuthnAuthGate — browser-side passkey AuthGate implementation.
 *
 * Uses the WebAuthn API (`navigator.credentials.get`) to request a
 * signed assertion from a registered passkey, then derives the
 * encryption key by HKDF'ing the assertion signature with a stable
 * context string.
 *
 * This adapter only runs in environments where `navigator.credentials`
 * exists. React Native apps should use `makeCallbackAuthGate` directly
 * with a native-module bridge instead.
 *
 * Usage:
 *
 *   const layer = makeWebAuthnAuthGate({
 *     rpId: "wallet.example.com",
 *     credentialIds: [base64UrlDecode(storedCredentialId)],
 *     userVerification: "required",
 *   })
 */

export interface WebAuthnAuthGateOptions {
  /** Relying Party ID (usually the site's effective domain). */
  readonly rpId: string
  /** Registered credential IDs to accept on this device. */
  readonly credentialIds: readonly Uint8Array[]
  readonly userVerification?: "required" | "preferred" | "discouraged"
  /** Fixed challenge for elevated-approval derivation context. */
  readonly keyDerivationContext?: string
  readonly timeoutMs?: number
}

// The minimum PublicKeyCredential shape we need.
interface AssertionCredential {
  readonly rawId: ArrayBuffer
  readonly response: {
    readonly signature: ArrayBuffer
    readonly authenticatorData: ArrayBuffer
    readonly clientDataJSON: ArrayBuffer
  }
}

const getWebAuthnAPI = ():
  | {
      get: (options: {
        publicKey: {
          challenge: Uint8Array
          rpId: string
          allowCredentials: ReadonlyArray<{
            id: Uint8Array
            type: "public-key"
          }>
          userVerification?: "required" | "preferred" | "discouraged"
          timeout?: number
        }
      }) => Promise<AssertionCredential | null>
    }
  | undefined => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = (globalThis as any).navigator as
    | { credentials?: { get?: Function } }
    | undefined
  if (!nav?.credentials?.get) return undefined
  return {
    get: async (options) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cred = await (nav.credentials!.get as any)(options)
      return cred as AssertionCredential | null
    },
  }
}

const randomChallenge = (): Uint8Array => {
  const out = new Uint8Array(32)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (globalThis as any).crypto as Crypto | undefined
  if (!c?.getRandomValues) {
    throw new Error("Web Crypto unavailable for WebAuthn challenge")
  }
  c.getRandomValues(out)
  return out
}

/**
 * Build a WebAuthn-backed AuthGate layer. Delegates to
 * `makeCallbackAuthGate` underneath — the callback invokes
 * `navigator.credentials.get()` and turns the assertion into an
 * `AuthApproval` + encryption key.
 */
export const makeWebAuthnAuthGate = (
  options: WebAuthnAuthGateOptions,
): Layer.Layer<AuthGateService> => {
  const webauthn = getWebAuthnAPI()
  const context = options.keyDerivationContext ?? "backup-encryption"

  const runAssertion = async (): Promise<{
    sigBytes: Uint8Array
  }> => {
    if (!webauthn) {
      throw new Error(
        "WebAuthn unavailable: navigator.credentials.get is not defined",
      )
    }
    const credential = await webauthn.get({
      publicKey: {
        challenge: randomChallenge(),
        rpId: options.rpId,
        allowCredentials: options.credentialIds.map((id) => ({
          id,
          type: "public-key",
        })),
        userVerification: options.userVerification ?? "required",
        timeout: options.timeoutMs,
      },
    })
    if (!credential) {
      throw new Error("WebAuthn returned no credential")
    }
    const sigBytes = new Uint8Array(credential.response.signature)
    return { sigBytes }
  }

  return makeCallbackAuthGate({
    timeoutMs: options.timeoutMs,
    promptApproval: async (_request: AuthRequest) => {
      try {
        await runAssertion()
        const approval: AuthApproval = {
          method: "passkey",
          timestamp: Date.now(),
        }
        return approval
      } catch (e) {
        throw new AuthDeniedError({
          reason: `passkey assertion failed: ${(e as Error).message}`,
        })
      }
    },
    getEncryptionKey: async () => {
      // Elevate: re-run the assertion and hash the signature into a
      // 32-byte symmetric key via HKDF-SHA256 with a stable context.
      // We hash the signature first so the raw passkey sig never leaves
      // this function.
      const { sigBytes } = await runAssertion()
      const seed = sha256(sigBytes)
      return deriveEncryptionKeyFromSecret(seed, context, 32)
    },
  })
}
