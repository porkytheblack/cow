import type { ChainId } from "./chain.js"

/**
 * Arbitrary call requests — one variant per chain kind. Keeps
 * `SignerService` / `BroadcastService` / auth gate / keyring entirely
 * unchanged: the adapter takes a typed request, returns an
 * `UnsignedTx`, and the rest of the pipeline is already generic.
 *
 * Encoding calldata / instruction bytes / entry-function arguments is
 * the caller's job — we don't wrap any ABI encoder. Users who want
 * ergonomic encoding can reach for `viem.encodeFunctionData` (EVM),
 * `@solana/web3.js` instruction builders, or `@aptos-labs/ts-sdk`
 * BCS serializers, all of which are already direct deps.
 */

export interface EvmCallRequest {
  readonly kind: "evm"
  /** Must start with `"evm:"`. Validated by the adapter. */
  readonly chain: ChainId
  readonly from: string
  readonly to: string
  /** Calldata hex (default `"0x"` for a pure value transfer). */
  readonly data?: `0x${string}`
  /** Native value to forward (wei). Default `0n`. */
  readonly value?: bigint
  /** Optional gas / fee overrides — omitted fields are estimated via RPC. */
  readonly gas?: bigint
  readonly maxFeePerGas?: bigint
  readonly maxPriorityFeePerGas?: bigint
  /** Legacy gasPrice fallback (used when the RPC lacks EIP-1559). */
  readonly gasPrice?: bigint
  readonly nonce?: number
  /** Shown in the auth-gate prompt and stored as `UnsignedTx.metadata.intent`. */
  readonly label?: string
}

export interface SolanaInstructionInput {
  /** Base58 program id. */
  readonly programId: string
  readonly keys: readonly {
    /** Base58 account pubkey. */
    readonly pubkey: string
    readonly isSigner: boolean
    readonly isWritable: boolean
  }[]
  /** Raw instruction data (program-specific encoding). */
  readonly data: Uint8Array
}

export interface SolanaCallRequest {
  readonly kind: "solana"
  readonly chain: ChainId
  readonly from: string
  readonly instructions: readonly SolanaInstructionInput[]
  readonly label?: string
}

export interface AptosCallRequest {
  readonly kind: "aptos"
  readonly chain: ChainId
  readonly from: string
  /** Fully-qualified entry function, e.g. `"0x1::coin::transfer"`. */
  readonly function: `${string}::${string}::${string}`
  readonly typeArguments?: readonly string[]
  readonly functionArguments: readonly unknown[]
  readonly label?: string
}

export type CallRequest =
  | EvmCallRequest
  | SolanaCallRequest
  | AptosCallRequest

/**
 * What `simulateCall` reports. Chain-generic: adapters fill the fields
 * they can produce. A successful EVM simulation returns `returnData`;
 * a reverted one returns `revertReason`. Solana / Aptos surface program
 * / VM error strings.
 */
export interface CallSimulation {
  readonly success: boolean
  readonly returnData?: `0x${string}` | Uint8Array
  readonly gasUsed?: bigint
  readonly revertReason?: string
  readonly logs?: readonly string[]
  /** Chain-native raw simulation response for caller introspection. */
  readonly raw?: unknown
}
