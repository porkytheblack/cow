import { Context, Effect, Layer, Ref } from "effect"
import type { AuthApproval, AuthLevel, AuthRequest } from "../model/auth.js"
import { AuthDeniedError, AuthTimeoutError } from "../model/errors.js"

interface ActiveSession {
  readonly approval: AuthApproval
  readonly level: AuthLevel
  readonly expiresAt: number
}

export interface AuthGateServiceShape {
  /**
   * Request user approval. If an active session covers the requested
   * level, returns the cached approval without prompting. Otherwise
   * delegates to the underlying prompt.
   */
  readonly requestApproval: (
    request: AuthRequest,
  ) => Effect.Effect<AuthApproval, AuthDeniedError | AuthTimeoutError>

  readonly registerPasskey: (credential: unknown) => Effect.Effect<void>
  readonly registerPin: (pinHash: Uint8Array) => Effect.Effect<void>

  readonly deriveEncryptionKey: () => Effect.Effect<
    Uint8Array,
    AuthDeniedError | AuthTimeoutError
  >

  /**
   * Prompt the user once and start a session that auto-approves
   * subsequent requests at the same or lower auth level until
   * `sessionTtlMs` elapses or `endSession()` is called.
   *
   * Useful for multi-transaction flows (CCTP burn + mint, batch
   * sends) where you want one approval dialog at the top.
   *
   * `level` defaults to `"elevated"` so the session covers everything.
   */
  readonly beginSession: (
    reason: string,
    level?: AuthLevel,
  ) => Effect.Effect<AuthApproval, AuthDeniedError | AuthTimeoutError>

  readonly endSession: () => Effect.Effect<void>
  readonly hasActiveSession: () => Effect.Effect<boolean>
}

export class AuthGateService extends Context.Tag("AuthGateService")<
  AuthGateService,
  AuthGateServiceShape
>() {}

const AUTH_LEVEL_RANK: Record<AuthLevel, number> = {
  standard: 0,
  elevated: 1,
}

/**
 * Wrap any auth gate layer with session support. The returned layer
 * intercepts `requestApproval`: if an active session exists whose
 * level is >= the requested level, it returns the cached approval
 * immediately.
 *
 * Consumers start a session via `beginSession("Batch transfer", "elevated")`
 * and end it with `endSession()`. The session also expires after
 * `sessionTtlMs` milliseconds.
 */
export const withSessionSupport = (
  innerGate: AuthGateServiceShape,
  sessionTtlMs: number,
): Effect.Effect<AuthGateServiceShape> =>
  Effect.gen(function* () {
    const sessionRef = yield* Ref.make<ActiveSession | null>(null)

    const getActiveSession = Effect.map(Ref.get(sessionRef), (s) =>
      s && s.expiresAt > Date.now() ? s : null,
    )

    return {
      requestApproval: (request) =>
        Effect.gen(function* () {
          const session = yield* getActiveSession
          if (
            session &&
            AUTH_LEVEL_RANK[session.level] >=
              AUTH_LEVEL_RANK[request.requiredLevel]
          ) {
            return {
              ...session.approval,
              timestamp: Date.now(),
            }
          }
          return yield* innerGate.requestApproval(request)
        }),

      registerPasskey: (cred) => innerGate.registerPasskey(cred),
      registerPin: (pin) => innerGate.registerPin(pin),
      deriveEncryptionKey: () => innerGate.deriveEncryptionKey(),

      beginSession: (reason, level) =>
        Effect.gen(function* () {
          const effectiveLevel = level ?? "elevated"
          const approval = yield* innerGate.requestApproval({
            reason,
            requiredLevel: effectiveLevel,
          })
          yield* Ref.set(sessionRef, {
            approval,
            level: effectiveLevel,
            expiresAt: Date.now() + sessionTtlMs,
          })
          return approval
        }),

      endSession: () => Ref.set(sessionRef, null),

      hasActiveSession: () =>
        Effect.map(getActiveSession, (s) => s !== null),
    }
  })

/**
 * Test layer — auto-approves every request. Elevated requests are also
 * approved but their method is set to "passkey" to model the contract.
 * The encryption key is a fixed 32-byte pattern so tests are deterministic.
 */
export const TestAuthGate = Layer.effect(
  AuthGateService,
  withSessionSupport(
    {
      requestApproval: (request: AuthRequest) =>
        Effect.succeed<AuthApproval>({
          method: request.requiredLevel === "elevated" ? "passkey" : "pin",
          timestamp: Date.now(),
          sessionToken: "test-session",
        }),
      registerPasskey: () => Effect.void,
      registerPin: () => Effect.void,
      deriveEncryptionKey: () =>
        Effect.succeed(new Uint8Array(32).fill(0x42)),
      beginSession: () =>
        Effect.succeed<AuthApproval>({
          method: "pin",
          timestamp: Date.now(),
          sessionToken: "test-session",
        }),
      endSession: () => Effect.void,
      hasActiveSession: () => Effect.succeed(false),
    },
    60_000,
  ),
)

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
  beginSession: () =>
    Effect.fail(new AuthDeniedError({ reason: "test: always denied" })),
  endSession: () => Effect.void,
  hasActiveSession: () => Effect.succeed(false),
})
