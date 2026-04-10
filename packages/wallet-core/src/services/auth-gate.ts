import { Context, Effect, Layer } from "effect"
import type { AuthApproval, AuthRequest } from "../model/auth.js"
import { AuthDeniedError, AuthTimeoutError } from "../model/errors.js"

export interface AuthGateServiceShape {
  /**
   * Request user approval. Resolves with an AuthApproval on success.
   * Fails with AuthDeniedError if the user rejects, or AuthTimeoutError
   * if the approval UI times out.
   */
  readonly requestApproval: (
    request: AuthRequest,
  ) => Effect.Effect<AuthApproval, AuthDeniedError | AuthTimeoutError>

  readonly registerPasskey: (credential: unknown) => Effect.Effect<void>
  readonly registerPin: (pinHash: Uint8Array) => Effect.Effect<void>

  /**
   * Derive a symmetric encryption key from the current auth material.
   * Used by BackupService to encrypt the keyring bundle.
   */
  readonly deriveEncryptionKey: () => Effect.Effect<
    Uint8Array,
    AuthDeniedError | AuthTimeoutError
  >
}

export class AuthGateService extends Context.Tag("AuthGateService")<
  AuthGateService,
  AuthGateServiceShape
>() {}

/**
 * Test layer — auto-approves every request. Elevated requests are also
 * approved but their method is set to "passkey" to model the contract.
 * The encryption key is a fixed 32-byte pattern so tests are deterministic.
 */
export const TestAuthGate = Layer.succeed(AuthGateService, {
  requestApproval: (request: AuthRequest) =>
    Effect.succeed<AuthApproval>({
      method: request.requiredLevel === "elevated" ? "passkey" : "pin",
      timestamp: Date.now(),
      sessionToken: "test-session",
    }),
  registerPasskey: () => Effect.void,
  registerPin: () => Effect.void,
  deriveEncryptionKey: () => Effect.succeed(new Uint8Array(32).fill(0x42)),
})

/**
 * Denying auth gate — every request fails. Used in tests to validate
 * that auth denial propagates correctly.
 */
export const DenyingAuthGate = Layer.succeed(AuthGateService, {
  requestApproval: () =>
    Effect.fail(new AuthDeniedError({ reason: "test: always denied" })),
  registerPasskey: () => Effect.void,
  registerPin: () => Effect.void,
  deriveEncryptionKey: () =>
    Effect.fail(new AuthDeniedError({ reason: "test: always denied" })),
})
