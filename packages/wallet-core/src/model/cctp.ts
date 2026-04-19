export interface BurnMessage {
  readonly sourceDomain: number
  readonly destDomain: number
  /**
   * Filled once the burn tx is confirmed on-chain. May be `0n` as a
   * placeholder when a record is first persisted pre-broadcast in the
   * `"burning"` status — consumers should only read `nonce` when
   * `messageBytes` is defined (i.e. the burn has been reconciled
   * against the chain).
   */
  readonly nonce: bigint
  readonly burnTxHash: string
  /**
   * The CCTP message bytes extracted from the confirmed burn. Absent
   * while a record is still in the `"burning"` status — the burn tx
   * has been signed and handed to the RPC but we have not yet read
   * back its on-chain state.
   */
  readonly messageBytes?: Uint8Array
  /** Keccak-256 of `messageBytes`, hex-encoded (no 0x prefix). */
  readonly messageHash?: string
}

export interface Attestation {
  readonly message: BurnMessage
  /** Hex-encoded Circle attestation signature (without the 0x prefix). */
  readonly attestation: string
}

export type CctpTransferStatus =
  | "burning"
  | "awaiting-attestation"
  | "attested"
  | "minting"
  | "completed"
  | "failed"

export interface PendingCctpTransfer {
  readonly id: string
  readonly planId: string
  readonly status: CctpTransferStatus
  readonly burn?: BurnMessage
  readonly attestation?: Attestation
  readonly mintTxHash?: string
  /** Source chain where the burn happened. */
  readonly sourceChain?: string
  /** Destination chain where the mint will happen. */
  readonly destChain?: string
  /** Recipient address on the destination chain. */
  readonly recipient?: string
  readonly createdAt: number
  readonly updatedAt: number
}
