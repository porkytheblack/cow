import { Context, Effect, Layer } from "effect"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { WalletConfigService } from "../config/index.js"
import { isUsdc } from "../model/asset.js"
import type { TransferIntent, TransferPlan, TransferStep } from "../model/transfer.js"
import {
  FeeEstimationError,
  InsufficientBalanceError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../model/errors.js"
import { CctpService } from "./cctp.js"
import { randomBytes } from "./keyring-crypto.js"
import { bytesToHex } from "@noble/hashes/utils"

const newId = (): string => bytesToHex(randomBytes(16))

export interface RouterServiceShape {
  /**
   * Decompose a TransferIntent into a concrete sequence of transactions.
   *
   *   - same chain           -> single direct-transfer step
   *   - cross-chain USDC     -> cctp-burn + cctp-mint (mint built post-attestation)
   *   - cross-chain non-USDC -> UnsupportedRouteError
   */
  readonly plan: (
    intent: TransferIntent,
  ) => Effect.Effect<
    TransferPlan,
    | UnsupportedRouteError
    | UnsupportedChainError
    | FeeEstimationError
    | InsufficientBalanceError,
    ChainAdapterRegistry | WalletConfigService | CctpService
  >
}

export class RouterService extends Context.Tag("RouterService")<
  RouterService,
  RouterServiceShape
>() {}

export const RouterServiceLive = Layer.succeed(RouterService, {
  plan: (intent) =>
    Effect.gen(function* () {
      const registry = yield* ChainAdapterRegistry
      const cctp = yield* CctpService

      const fromChain = intent.from.chain
      const toChain = intent.to.chain

      if (fromChain === toChain) {
        const adapter = yield* registry.get(fromChain)
        const tx = yield* adapter.buildTransferTx({
          from: intent.from.address,
          to: intent.to.address,
          asset: intent.asset,
          amount: intent.amount,
        })
        const step: TransferStep = { type: "direct-transfer", chain: fromChain, tx }
        const plan: TransferPlan = {
          id: newId(),
          intent,
          steps: [step],
          isCrossChain: false,
        }
        return plan
      }

      // Cross-chain — only USDC via CCTP is supported.
      if (!isUsdc(intent.asset)) {
        return yield* Effect.fail(
          new UnsupportedRouteError({
            from: String(fromChain),
            to: String(toChain),
            asset: intent.asset.symbol,
          }),
        )
      }

      // Delegate burn-tx construction to CctpService so the per-chain
      // TokenMessenger encoding stays in one place (the source adapter).
      const burnTx = yield* cctp.buildBurnTx({
        sourceChain: fromChain,
        destChain: toChain,
        amount: intent.amount,
        from: intent.from.address,
        recipient: intent.to.address,
      })

      const steps: TransferStep[] = [
        { type: "cctp-burn", sourceChain: fromChain, destChain: toChain, tx: burnTx },
        { type: "cctp-mint", destChain: toChain },
      ]
      const plan: TransferPlan = {
        id: newId(),
        intent,
        steps,
        isCrossChain: true,
      }
      return plan
    }),
})
