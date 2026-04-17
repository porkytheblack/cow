import { Context, Effect, Layer } from "effect"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { SignedTx, UnsignedTx } from "../model/transaction.js"
import {
  AuthDeniedError,
  AuthTimeoutError,
  FeeEstimationError,
  KeyNotFoundError,
  StorageError,
  UnsupportedChainError,
} from "../model/errors.js"
import { AuthGateService } from "./auth-gate.js"
import { KeyringService } from "./keyring.js"

export interface SignerServiceShape {
  /**
   * Request auth and sign via the keyring-owned private key, never
   * exposing the key outside KeyringService. The flow is:
   *
   *   1. Get approval from the AuthGate.
   *   2. Ask the ChainAdapter for the curve-specific signing bytes.
   *   3. Hand those bytes + approval to KeyringService.signBytes,
   *      which signs internally and returns only the signature.
   *   4. Ask the ChainAdapter to wrap the signature into a full SignedTx.
   */
  readonly sign: (
    tx: UnsignedTx,
  ) => Effect.Effect<
    SignedTx,
    | KeyNotFoundError
    | AuthDeniedError
    | AuthTimeoutError
    | UnsupportedChainError
    | FeeEstimationError
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

export const SignerServiceLive = Layer.succeed(SignerService, {
  sign: (tx: UnsignedTx) =>
    Effect.gen(function* () {
      const auth = yield* AuthGateService
      const keyring = yield* KeyringService
      const registry = yield* ChainAdapterRegistry
      const configService = yield* WalletConfigService

      // The config's `elevatedThreshold` is compared against the tx's
      // estimated fee. UnsignedTx has no intrinsic "value" field, so
      // fee is the closest proxy for "is this a big transaction?".
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

      // 1. Ask the adapter what bytes to sign over.
      const message = yield* adapter.buildSigningMessage(tx)

      // 2. Ask the keyring for the public key metadata and the signature.
      //    The private key never leaves KeyringService. `tx.from` routes
      //    to the correct account when multiple accounts exist on the
      //    same chain.
      const derivedKey = yield* keyring.getKey(tx.chain, tx.from)
      const signature = yield* keyring.signBytes(
        tx.chain,
        message,
        approval,
        tx.from,
      )

      // 3. Hand the signature + public key back to the adapter to assemble
      //    the broadcast-ready SignedTx.
      const signed = yield* adapter.attachSignature(
        tx,
        signature,
        derivedKey.publicKey,
      )
      return signed
    }),
})
