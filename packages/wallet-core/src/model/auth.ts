export type AuthMethod = "passkey" | "pin" | "biometric"

export type AuthLevel = "standard" | "elevated"

export interface AuthRequest {
  readonly reason: string
  readonly requiredLevel: AuthLevel
}

export interface AuthApproval {
  readonly method: AuthMethod
  readonly timestamp: number
  /** Optional short-lived session token for batching rapid actions. */
  readonly sessionToken?: string
}
