import type { ChainId } from "./chain.js"

export interface TxMetadata {
  /** Human-readable label, e.g. "Transfer 10 USDC to 0x..." */
  readonly intent: string
  readonly createdAt: number
  /** Links to a TransferPlan when part of a multi-step operation */
  readonly transferId?: string
}

export interface UnsignedTx {
  readonly chain: ChainId
  readonly from: string
  /** Chain-native payload (AptosEntryFunction | SolanaTransaction | EvmTxRequest) */
  readonly payload: unknown
  readonly estimatedFee?: bigint
  readonly metadata: TxMetadata
}

export interface SignedTx {
  readonly chain: ChainId
  /** Serialised signed bytes, ready to broadcast. */
  readonly raw: Uint8Array
  readonly hash: string
  readonly unsigned: UnsignedTx
}

export interface TxReceipt {
  readonly chain: ChainId
  readonly hash: string
  readonly status: "confirmed" | "failed"
  readonly blockNumber?: bigint
  readonly fee?: bigint
  /** Chain-native receipt for caller introspection (e.g. CCTP burn log parsing) */
  readonly raw?: unknown
}
