import { Effect, Layer } from "effect"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha256"
import type { AuthApproval, AuthMethod, AuthRequest } from "../model/auth.js"
import { AuthDeniedError, AuthTimeoutError } from "../model/errors.js"
import { AuthGateService, withSessionSupport } from "./auth-gate.js"

/**
 * CallbackAuthGate — bridges `AuthGateService` to caller-supplied
 * async callbacks. This is the primitive that React Native and browser
 * apps use to wire their native passkey / biometric / PIN prompts into
 * the wallet's approval flow.
 *
 * The caller supplies:
 *
 *   promptApproval(request) -> Promise<AuthApproval | null>
 *     Called when the wallet needs approval. Return an AuthApproval on
 *     success, null to deny, or throw to produce an
 *     `AuthDeniedError` with a synthetic reason.
 *
 *   getEncryptionKey() -> Promise<Uint8Array>
 *     Called by BackupService to derive the encryption key that wraps
 *     the keyring bundle. Typical implementations do a passkey /
 *     PIN-gated HKDF over a high-entropy secret.
 *
 * Optional hooks:
 *
 *   registerPasskey(credential) -> Promise<void>
 *   registerPin(pinHash) -> Promise<void>
 *   timeoutMs: number — deny with AuthTimeoutError if the prompt takes
 *              longer than this. Defaults to 5 minutes.
 */

export interface CallbackAuthGateHooks {
  readonly promptApproval: (
    request: AuthRequest,
  ) => Promise<AuthApproval | null>
  readonly getEncryptionKey: () => Promise<Uint8Array>
  readonly registerPasskey?: (credential: unknown) => Promise<void>
  readonly registerPin?: (pinHash: Uint8Array) => Promise<void>
  readonly timeoutMs?: number
  /** How long a session started by `beginSession()` lasts. Default 5 min. */
  readonly sessionTtlMs?: number
}

const withTimeout = <A, E1, E2>(
  effect: Effect.Effect<A, E1>,
  timeoutMs: number,
  onTimeout: () => E2,
): Effect.Effect<A, E1 | E2> =>
  Effect.raceFirst(
    effect as Effect.Effect<A, E1 | E2>,
    Effect.sleep(timeoutMs).pipe(
      Effect.flatMap(() => Effect.fail<E1 | E2>(onTimeout())),
    ),
  )

export const makeCallbackAuthGate = (
  hooks: CallbackAuthGateHooks,
): Layer.Layer<AuthGateService> => {
  const timeoutMs = hooks.timeoutMs ?? 5 * 60_000
  const sessionTtlMs = hooks.sessionTtlMs ?? 5 * 60_000

  const innerGate = {
    requestApproval: (request: AuthRequest) =>
      withTimeout(
        Effect.tryPromise({
          try: () => hooks.promptApproval(request),
          catch: (cause) =>
            new AuthDeniedError({
              reason: `prompt threw: ${(cause as Error).message}`,
            }),
        }).pipe(
          Effect.flatMap((approval) =>
            approval
              ? Effect.succeed(approval)
              : Effect.fail(
                  new AuthDeniedError({ reason: "user denied approval" }),
                ),
          ),
        ),
        timeoutMs,
        () => new AuthTimeoutError({ reason: `approval prompt timed out after ${timeoutMs}ms` }),
      ),

    registerPasskey: (credential: unknown) =>
      Effect.tryPromise({
        try: () => hooks.registerPasskey?.(credential) ?? Promise.resolve(),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),

    registerPin: (pinHash: Uint8Array) =>
      Effect.tryPromise({
        try: () => hooks.registerPin?.(pinHash) ?? Promise.resolve(),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),

    deriveEncryptionKey: () =>
      withTimeout(
        Effect.tryPromise({
          try: () => hooks.getEncryptionKey(),
          catch: (cause) =>
            new AuthDeniedError({
              reason: `getEncryptionKey threw: ${(cause as Error).message}`,
            }),
        }),
        timeoutMs,
        () =>
          new AuthTimeoutError({
            reason: `encryption-key derivation timed out after ${timeoutMs}ms`,
          }),
      ),

    // Stubs — withSessionSupport replaces these with real impls.
    beginSession: () => innerGate.requestApproval({ reason: "session", requiredLevel: "elevated" }),
    endSession: () => Effect.void,
    hasActiveSession: () => Effect.succeed(false),
  }

  return Layer.effect(AuthGateService, withSessionSupport(innerGate, sessionTtlMs))
}

/**
 * Build an encryption key from a secret + context via HKDF-SHA256.
 * Exposed as a helper for callers implementing `getEncryptionKey`
 * from a passkey signature / PIN hash / TEE secret.
 */
export const deriveEncryptionKeyFromSecret = (
  secret: Uint8Array,
  context: string,
  length = 32,
): Uint8Array =>
  hkdf(sha256, secret, new Uint8Array(0), `wallet-core/${context}`, length)

// Re-export for ergonomic imports.
export type { AuthMethod, AuthRequest, AuthApproval }
