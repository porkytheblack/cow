import { Context, Effect, Layer } from "effect"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import type { SignedTx, TxReceipt } from "../model/transaction.js"
import { BroadcastError, UnsupportedChainError } from "../model/errors.js"

export interface BroadcastServiceShape {
  readonly submit: (
    signed: SignedTx,
  ) => Effect.Effect<
    TxReceipt,
    BroadcastError | UnsupportedChainError,
    ChainAdapterRegistry
  >
}

export class BroadcastService extends Context.Tag("BroadcastService")<
  BroadcastService,
  BroadcastServiceShape
>() {}

export const BroadcastServiceLive = Layer.succeed(BroadcastService, {
  submit: (signed) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const adapter = yield* registry.get(signed.chain)
      return yield* adapter.broadcast(signed)
    }),
})
