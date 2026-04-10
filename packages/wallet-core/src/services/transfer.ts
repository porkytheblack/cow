import { Context, Effect, Layer } from "effect"
import { bytesToHex } from "@noble/hashes/utils"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { FetchAdapter } from "../adapters/fetch/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { PendingCctpTransfer } from "../model/cctp.js"
import type { TxReceipt } from "../model/transaction.js"
import type { TransferIntent } from "../model/transfer.js"
import {
  AuthDeniedError,
  AuthTimeoutError,
  BroadcastError,
  CctpAttestationTimeout,
  CctpMintError,
  FeeEstimationError,
  InsufficientBalanceError,
  KeyNotFoundError,
  StorageError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../model/errors.js"
import { AuthGateService } from "./auth-gate.js"
import { BalanceService } from "./balance.js"
import { BroadcastService } from "./broadcast.js"
import { CctpService } from "./cctp.js"
import { KeyringService } from "./keyring.js"
import { randomBytes } from "./keyring-crypto.js"
import { RouterService } from "./router.js"
import { SignerService } from "./signer.js"

export interface CompletedStep {
  readonly type: string
  readonly receipt?: TxReceipt
  readonly pendingCctp?: PendingCctpTransfer
}

export interface TransferResult {
  readonly planId: string
  readonly steps: readonly CompletedStep[]
  readonly status: "completed" | "pending-cctp"
}

export interface TransferServiceShape {
  readonly execute: (
    intent: TransferIntent,
  ) => Effect.Effect<
    TransferResult,
    | UnsupportedRouteError
    | UnsupportedChainError
    | InsufficientBalanceError
    | FeeEstimationError
    | AuthDeniedError
    | AuthTimeoutError
    | BroadcastError
    | CctpAttestationTimeout
    | CctpMintError
    | KeyNotFoundError
    | StorageError,
    | RouterService
    | SignerService
    | BroadcastService
    | BalanceService
    | CctpService
    | ChainAdapterRegistry
    | AuthGateService
    | KeyringService
    | StorageAdapter
    | WalletConfigService
    | FetchAdapter
  >
}

export class TransferService extends Context.Tag("TransferService")<
  TransferService,
  TransferServiceShape
>() {}

const newId = (): string => bytesToHex(randomBytes(16))

export const TransferServiceLive = Layer.succeed(TransferService, {
  execute: (intent) =>
    Effect.gen(function* () {
      const router = yield* RouterService
      const signer = yield* SignerService
      const broadcast = yield* BroadcastService
      const balance = yield* BalanceService
      const cctp = yield* CctpService
      const registry = yield* ChainAdapterRegistry

      // 1. Pre-flight balance check on the source address.
      const srcBalance = yield* balance.getBalance(
        intent.from.chain,
        intent.from.address,
        intent.asset,
      )
      if (srcBalance.balance < intent.amount) {
        return yield* Effect.fail(
          new InsufficientBalanceError({
            chain: String(intent.from.chain),
            required: intent.amount,
            available: srcBalance.balance,
          }),
        )
      }

      // 2. Plan the transfer.
      const plan = yield* router.plan(intent)

      // 3. Execute steps sequentially, threading CCTP state through
      //    steps for cross-chain transfers.
      const completed: CompletedStep[] = []

      for (const step of plan.steps) {
        if (step.type === "direct-transfer") {
          const signed = yield* signer.sign(step.tx)
          const receipt = yield* broadcast.submit(signed)
          completed.push({ type: step.type, receipt })
          continue
        }

        if (step.type === "cctp-burn") {
          const signed = yield* signer.sign(step.tx)
          const burnReceipt = yield* broadcast.submit(signed)
          // Parse burn log into a BurnMessage.
          const srcAdapter = yield* registry.get(step.sourceChain)
          const burnMsg = yield* srcAdapter.extractBurnMessage(burnReceipt)

          const pending: PendingCctpTransfer = {
            id: newId(),
            planId: plan.id,
            status: "awaiting-attestation",
            burn: burnMsg,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          yield* cctp.savePending(pending)

          // 4. Wait for Circle attestation.
          const attestation = yield* cctp.waitForAttestation(burnMsg)

          // 5. Build & submit the mint on the destination chain.
          const mintTx = yield* cctp.buildMintTx(
            intent.to.address,
            step.destChain,
            attestation,
          )
          const mintSigned = yield* signer.sign(mintTx)
          const mintReceipt = yield* broadcast.submit(mintSigned)
          completed.push({
            type: "cctp",
            receipt: mintReceipt,
            pendingCctp: { ...pending, status: "completed", attestation },
          })
          continue
        }

        if (step.type === "cctp-mint") {
          // Placeholder from the router; already handled above as part
          // of cctp-burn. Skip it here.
          continue
        }
      }

      return {
        planId: plan.id,
        steps: completed,
        status: "completed",
      } as const
    }),
})
