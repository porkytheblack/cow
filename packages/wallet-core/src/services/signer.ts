import { Context, Effect, Layer } from "effect"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { SignedTx, UnsignedTx } from "../model/transaction.js"
import {
  AuthDeniedError,
  AuthTimeoutError,
  KeyNotFoundError,
  StorageError,
  UnsupportedChainError,
} from "../model/errors.js"
import { AuthGateService } from "./auth-gate.js"
import { KeyringService } from "./keyring.js"

export interface SignerServiceShape {
  /**
   * Request auth, pull the chain-specific private key from the keyring,
   * delegate signing to the chain adapter, and return the signed tx.
   */
  readonly sign: (
    tx: UnsignedTx,
  ) => Effect.Effect<
    SignedTx,
    | KeyNotFoundError
    | AuthDeniedError
    | AuthTimeoutError
    | UnsupportedChainError
    | StorageError,
    | KeyringService
    | AuthGateService
    | ChainAdapterRegistry
    | StorageAdapter
    | WalletConfigService
  >
}

export class SignerService extends Context.Tag("SignerService")<
  SignerService,
  SignerServiceShape
>() {}

const textEncoder = new TextEncoder()

export const SignerServiceLive = Layer.succeed(SignerService, {
  sign: (tx: UnsignedTx) =>
    Effect.gen(function* () {
      const auth = yield* AuthGateService
      const keyring = yield* KeyringService
      const registry = yield* ChainAdapterRegistry
      const configService = yield* WalletConfigService

      const elevatedThreshold = configService.config.auth.elevatedThreshold
      const level: "standard" | "elevated" =
        tx.estimatedFee !== undefined && tx.estimatedFee >= elevatedThreshold
          ? "elevated"
          : "standard"

      const approval = yield* auth.requestApproval({
        reason: tx.metadata.intent,
        requiredLevel: level,
      })

      const adapter = yield* registry.get(tx.chain)

      // signBytes verifies the approval and returns the raw private key
      // bytes. The key lives only for the duration of this effect.
      const privateKey = yield* keyring.signBytes(
        tx.chain,
        textEncoder.encode(JSON.stringify(tx.payload)),
        approval,
      )

      const signed = yield* adapter.sign(tx, privateKey)
      return signed
    }),
})
