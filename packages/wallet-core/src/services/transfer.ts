import { Context, Effect, Layer } from "effect"
import { bytesToHex } from "@noble/hashes/utils"
import { ChainAdapterRegistry } from "../adapters/chain/index.js"
import { FetchAdapter } from "../adapters/fetch/index.js"
import { StorageAdapter } from "../adapters/storage/index.js"
import { WalletConfigService } from "../config/index.js"
import type { BurnMessage, PendingCctpTransfer } from "../model/cctp.js"
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
          const srcAdapter = yield* registry.get(step.sourceChain)

          // 1. Persist a `burning` record BEFORE broadcast. The hash is
          //    already known from the signed tx; `messageBytes` is left
          //    unset until we can read it back from the confirmed tx.
          //    A crash or broadcast error after this point leaves us
          //    with a durable record that resumeTransfer can reconcile.
          const id = newId()
          const now = Date.now()
          const burnStub: BurnMessage = {
            sourceDomain: 0,
            destDomain: 0,
            nonce: 0n,
            burnTxHash: signed.hash,
          }
          const initial: PendingCctpTransfer = {
            id,
            planId: plan.id,
            status: "burning",
            burn: burnStub,
            sourceChain: String(step.sourceChain),
            destChain: String(step.destChain),
            recipient: intent.to.address,
            createdAt: now,
            updatedAt: now,
          }
          yield* cctp.savePending(initial)

          // 2. Broadcast. On error, probe the chain: the Solana
          //    `sendTransaction` RPC sometimes returns an error for a tx
          //    the cluster actually accepted. If we find the burn on
          //    chain, swallow the broadcast error and extract the
          //    BurnMessage directly. If the probe is also negative or
          //    inconclusive, mark the record `failed` and propagate the
          //    original BroadcastError.
          type BurnOutcome =
            | { kind: "receipt"; receipt: TxReceipt }
            | { kind: "reconciled"; burn: BurnMessage }
          const outcome: BurnOutcome = yield* broadcast.submit(signed).pipe(
            Effect.map(
              (receipt) => ({ kind: "receipt", receipt }) satisfies BurnOutcome,
            ),
            Effect.catchTag("BroadcastError", (broadcastErr) =>
              srcAdapter
                .extractBurnMessageFromTx(signed.hash)
                .pipe(
                  Effect.catchTag("BroadcastError", () =>
                    Effect.succeed(null as BurnMessage | null),
                  ),
                  Effect.flatMap((reconciled) =>
                    reconciled !== null
                      ? Effect.succeed({
                          kind: "reconciled" as const,
                          burn: reconciled,
                        } satisfies BurnOutcome)
                      : cctp
                          .updatePending(id, {
                            status: "failed",
                            updatedAt: Date.now(),
                          })
                          .pipe(Effect.flatMap(() => Effect.fail(broadcastErr))),
                  ),
                ),
            ),
          )

          // 3. Resolve the BurnMessage: either extract from the live
          //    receipt or reuse the one we already reconciled from chain.
          const burnMsg: BurnMessage =
            outcome.kind === "receipt"
              ? yield* srcAdapter.extractBurnMessage(outcome.receipt)
              : outcome.burn
          yield* cctp.updatePending(id, {
            status: "awaiting-attestation",
            burn: burnMsg,
            updatedAt: Date.now(),
          })

          // 4. Wait for Circle attestation.
          const attestation = yield* cctp.waitForAttestation(burnMsg)
          yield* cctp.updatePending(id, {
            status: "attested",
            attestation,
            updatedAt: Date.now(),
          })

          // 5. Build + sign the mint. Save `minting` before broadcast so
          //    a broadcast error here also leaves a recoverable record.
          const mintTx = yield* cctp.buildMintTx(
            intent.to.address,
            step.destChain,
            attestation,
          )
          const mintSigned = yield* signer.sign(mintTx)
          yield* cctp.updatePending(id, {
            status: "minting",
            mintTxHash: mintSigned.hash,
            updatedAt: Date.now(),
          })
          const mintReceipt = yield* broadcast.submit(mintSigned)
          yield* cctp.updatePending(id, {
            status: "completed",
            mintTxHash: mintReceipt.hash,
            updatedAt: Date.now(),
          })

          const finalRecord: PendingCctpTransfer = {
            ...initial,
            status: "completed",
            burn: burnMsg,
            attestation,
            mintTxHash: mintReceipt.hash,
            updatedAt: Date.now(),
          }
          completed.push({
            type: "cctp",
            receipt: mintReceipt,
            pendingCctp: finalRecord,
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
