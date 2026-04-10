import type { AssetId } from "./asset.js"
import type { ChainAddress, ChainId } from "./chain.js"
import type { UnsignedTx } from "./transaction.js"

export interface TransferIntent {
  readonly from: ChainAddress
  readonly to: ChainAddress
  readonly asset: AssetId
  readonly amount: bigint
}

export type TransferStep =
  | {
      readonly type: "direct-transfer"
      readonly chain: ChainId
      readonly tx: UnsignedTx
    }
  | {
      readonly type: "cctp-burn"
      readonly sourceChain: ChainId
      readonly destChain: ChainId
      readonly tx: UnsignedTx
    }
  | {
      readonly type: "cctp-mint"
      readonly destChain: ChainId
      // Mint tx is built after attestation, so it's placeholder at planning time.
    }

export interface TransferPlan {
  readonly id: string
  readonly intent: TransferIntent
  readonly steps: readonly TransferStep[]
  readonly isCrossChain: boolean
}
