export interface BurnMessage {
  readonly sourceDomain: number
  readonly destDomain: number
  readonly nonce: bigint
  readonly burnTxHash: string
  readonly messageBytes: Uint8Array
  readonly messageHash: string
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
  readonly createdAt: number
  readonly updatedAt: number
}
