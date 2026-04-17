import { Context, Effect, Layer } from "effect"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { CallRequest, CallSimulation } from "../model/call.js"
import type { TxReceipt, UnsignedTx } from "../model/transaction.js"
import {
  AuthDeniedError,
  AuthTimeoutError,
  BroadcastError,
  FeeEstimationError,
  KeyNotFoundError,
  StorageError,
  UnsupportedChainError,
} from "../model/errors.js"
import { AuthGateService } from "./auth-gate.js"
import { BroadcastService } from "./broadcast.js"
import { KeyringService } from "./keyring.js"
import { SignerService } from "./signer.js"

/**
 * `CallService` — arbitrary contract / entry-function calls.
 *
 * The chain-specific pipework (`buildCallTx`, `simulateCall`) lives on
 * the adapter. This service just glues those to the pre-existing
 * signer + broadcast flow, so calls automatically inherit auth-gate
 * prompts, session reuse, elevated-fee escalation, and keyring-owned
 * signing — the same guarantees `transfer()` gives.
 */
export interface CallServiceShape {
  readonly build: (
    req: CallRequest,
  ) => Effect.Effect<
    UnsignedTx,
    FeeEstimationError | UnsupportedChainError,
    ChainAdapterRegistry
  >

  readonly simulate: (
    req: CallRequest,
  ) => Effect.Effect<
    CallSimulation,
    FeeEstimationError | UnsupportedChainError,
    ChainAdapterRegistry
  >

  readonly execute: (
    req: CallRequest,
  ) => Effect.Effect<
    TxReceipt,
    | FeeEstimationError
    | UnsupportedChainError
    | AuthDeniedError
    | AuthTimeoutError
    | KeyNotFoundError
    | StorageError
    | BroadcastError,
    | ChainAdapterRegistry
    | SignerService
    | BroadcastService
    | AuthGateService
    | KeyringService
    | StorageAdapter
    | WalletConfigService
  >
}

export class CallService extends Context.Tag("CallService")<
  CallService,
  CallServiceShape
>() {}

export const CallServiceLive = Layer.succeed(CallService, {
  build: (req) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(req.chain)
      return yield* adapter.buildCallTx(req)
    }),

  simulate: (req) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(req.chain)
      return yield* adapter.simulateCall(req)
    }),

  execute: (req) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const signer = yield* SignerService
      const broadcast = yield* BroadcastService

      const adapter = yield* registry.get(req.chain)
      const tx = yield* adapter.buildCallTx(req)
      const signed = yield* signer.sign(tx)
      return yield* broadcast.submit(signed)
    }),
})
