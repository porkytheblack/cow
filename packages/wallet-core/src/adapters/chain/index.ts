import { Context, Effect } from "effect"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainId } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  InsufficientBalanceError,
  UnsupportedChainError,
} from "../../model/errors.js"

export interface BuildTransferParams {
  readonly from: string
  readonly to: string
  readonly asset: AssetId
  readonly amount: bigint
}

/**
 * A ChainAdapter encapsulates all chain-specific logic: address derivation,
 * transaction building, signing, broadcasting, and balance queries. Every
 * adapter is pure — it uses the injected FetchAdapter for I/O.
 */
export interface ChainAdapter {
  readonly chainId: ChainId

  readonly deriveAddress: (
    publicKey: Uint8Array,
  ) => Effect.Effect<string, UnsupportedChainError>

  readonly buildTransferTx: (
    params: BuildTransferParams,
  ) => Effect.Effect<UnsignedTx, FeeEstimationError | InsufficientBalanceError>

  readonly estimateFee: (
    tx: UnsignedTx,
  ) => Effect.Effect<bigint, FeeEstimationError>

  readonly broadcast: (signed: SignedTx) => Effect.Effect<TxReceipt, BroadcastError>

  readonly getBalance: (address: string, asset: AssetId) => Effect.Effect<bigint>

  readonly getAllBalances: (
    address: string,
  ) => Effect.Effect<readonly TokenBalance[]>

  readonly sign: (
    tx: UnsignedTx,
    privateKey: Uint8Array,
  ) => Effect.Effect<SignedTx>

  /**
   * Parse a burn receipt into a CCTP BurnMessage. Only chains with CCTP
   * support implement this meaningfully; others return a placeholder.
   */
  readonly extractBurnMessage: (
    receipt: TxReceipt,
  ) => Effect.Effect<BurnMessage, BroadcastError>

  /**
   * Build the mint / receiveMessage transaction on this chain given a
   * Circle attestation. Source adapter produces the burn; destination
   * adapter produces the mint.
   */
  readonly buildMintTx: (params: {
    readonly recipient: string
    readonly messageBytes: Uint8Array
    readonly attestation: string
  }) => Effect.Effect<UnsignedTx, FeeEstimationError>
}

export interface ChainAdapterRegistryShape {
  readonly get: (
    chainId: ChainId,
  ) => Effect.Effect<ChainAdapter, UnsupportedChainError>
  readonly supported: () => readonly ChainId[]
}

export class ChainAdapterRegistry extends Context.Tag("ChainAdapterRegistry")<
  ChainAdapterRegistry,
  ChainAdapterRegistryShape
>() {}
