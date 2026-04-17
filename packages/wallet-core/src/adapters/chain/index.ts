import { Context, Effect } from "effect"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { CallRequest, CallSimulation } from "../../model/call.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainId } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  InsufficientBalanceError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../../model/errors.js"

export interface BuildTransferParams {
  readonly from: string
  readonly to: string
  readonly asset: AssetId
  readonly amount: bigint
}

export interface BuildCctpBurnParams {
  readonly from: string
  readonly destinationDomain: number
  readonly recipient: string
  readonly amount: bigint
}

/**
 * A ChainAdapter encapsulates all chain-specific logic: address derivation,
 * transaction building, signing, broadcasting, and balance queries. Every
 * adapter is pure — it uses the injected FetchAdapter for I/O.
 *
 * Signing is split into three steps so that private keys never leave
 * KeyringService:
 *
 *   1. `buildSigningMessage(tx)` — returns the chain-curve-specific bytes
 *      the signing key must operate on (a keccak256 digest for EVM, the
 *      raw signing message for ed25519 chains).
 *   2. KeyringService.signBytes(chain, message, approval) — signs the
 *      bytes internally and returns a curve-specific signature.
 *   3. `attachSignature(tx, signature, publicKey)` — wraps the tx with the
 *      signature into a broadcast-ready `SignedTx`.
 *
 * A convenience `sign(tx, privateKey)` helper is retained for adapter-level
 * unit tests that want to exercise the full cycle without KeyringService.
 * Services must NOT call it — they must go through the three-step flow.
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

  /**
   * Produce the bytes that a signing key must operate on for this tx.
   * For EVM this is the 32-byte keccak256 digest of the serialized tx;
   * for ed25519 chains it is the full message-with-domain-prefix that
   * ed25519 will hash internally.
   */
  readonly buildSigningMessage: (
    tx: UnsignedTx,
  ) => Effect.Effect<Uint8Array, FeeEstimationError>

  /**
   * Wrap a raw curve-specific signature (produced by KeyringService over
   * the bytes returned by `buildSigningMessage`) into a fully serialized
   * `SignedTx` ready for broadcast.
   *
   *   - ed25519 signatures are 64 bytes.
   *   - secp256k1 signatures are 65 bytes (r || s || v) where v is the
   *     recovery id (0 or 1); the adapter is responsible for any
   *     EIP-155 / EIP-1559 v adjustments.
   */
  readonly attachSignature: (
    tx: UnsignedTx,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ) => Effect.Effect<SignedTx, FeeEstimationError>

  /**
   * @deprecated Use `buildSigningMessage` + `KeyringService.signBytes` +
   * `attachSignature`. Retained only for adapter-level unit tests.
   */
  readonly sign: (
    tx: UnsignedTx,
    privateKey: Uint8Array,
  ) => Effect.Effect<SignedTx>

  /**
   * Build an `UnsignedTx` for an arbitrary contract call / entry-function
   * invocation. The adapter validates that `req.kind` matches its chain
   * kind and fails with `UnsupportedChainError` otherwise. Used by
   * `CallService.build`.
   */
  readonly buildCallTx: (
    req: CallRequest,
  ) => Effect.Effect<UnsignedTx, FeeEstimationError | UnsupportedChainError>

  /**
   * Dry-run the call without signing. Returns return-data / gasUsed on
   * success and `revertReason` / `logs` on failure. Adapters map the
   * chain-native simulate response into `CallSimulation`.
   */
  readonly simulateCall: (
    req: CallRequest,
  ) => Effect.Effect<
    CallSimulation,
    FeeEstimationError | UnsupportedChainError
  >

  /**
   * Build a CCTP burn (`depositForBurn`) tx for this chain. Adapters
   * without CCTP support return `UnsupportedRouteError`. Used by
   * `CctpService.buildBurnTx`.
   */
  readonly buildCctpBurnTx: (
    params: BuildCctpBurnParams,
  ) => Effect.Effect<
    UnsignedTx,
    FeeEstimationError | UnsupportedRouteError
  >

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
