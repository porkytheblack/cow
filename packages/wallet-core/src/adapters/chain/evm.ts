import { Effect } from "effect"
import {
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializable,
  type TransactionSerializableEIP1559,
} from "viem"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { CallRequest, CallSimulation } from "../../model/call.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainConfig, ChainId } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  UnsupportedChainError,
  UnsupportedRouteError,
} from "../../model/errors.js"
import type { FetchAdapterShape } from "../fetch/index.js"
import type { ChainAdapter } from "./index.js"
import { jsonRpcCall } from "./json-rpc.js"

/**
 * EvmChainAdapter — a full EVM chain adapter. Works with any EVM chain
 * identified by `chainId: "evm:<numeric-id>"`. All HTTP flows through
 * the injected FetchAdapter. No direct use of `fetch`, no viem `http`
 * transport, no Node polyfills.
 *
 * Signing uses `@noble/curves/secp256k1` directly so the adapter can
 * operate on the signing digest and attach the signature via viem's
 * `serializeTransaction(tx, sig)` — that way the private key stays in
 * KeyringService and never reaches the adapter.
 *
 * CCTP V2 support:
 *   - buildTransferTx recognises USDC and builds an ERC20 `transfer`.
 *   - buildBurnTx (exposed via CctpService) calls
 *     `TokenMessenger.depositForBurn(...)`.
 *   - extractBurnMessage parses the `MessageSent` log on the
 *     MessageTransmitter contract.
 *   - buildMintTx calls `MessageTransmitter.receiveMessage(...)`.
 */

// --- Internal payload shape ---------------------------------------------

interface EvmCallPayload {
  readonly kind: "direct-transfer" | "contract-call" | "cctp-burn" | "cctp-mint"
  readonly to: Address
  readonly value: bigint
  readonly data: Hex
  /**
   * Filled in by `buildTransferTx` / `buildCctpBurnTx`. EIP-1559 tx:
   * `maxFeePerGas` + `maxPriorityFeePerGas`. The adapter falls back to
   * legacy (`gasPrice`) only if the RPC does not support
   * `eth_maxPriorityFeePerGas`.
   */
  readonly gas?: bigint
  readonly maxFeePerGas?: bigint
  readonly maxPriorityFeePerGas?: bigint
  /** Present for chains that don't expose EIP-1559 fee history. */
  readonly gasPrice?: bigint
  readonly nonce?: number
  readonly asset?: AssetId
}

// --- Contract selectors -------------------------------------------------

/** ERC20 `transfer(address,uint256)` selector. */
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const

/**
 * CCTP V1 TokenMessenger.depositForBurn (4 params — used by chains
 * that haven't upgraded to V2 yet, e.g. Aptos).
 */
const CCTP_V1_DEPOSIT_FOR_BURN_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
    ],
    outputs: [{ type: "uint64" }],
  },
] as const

/**
 * CCTP V2 TokenMessenger.depositForBurn (7 params — adds
 * destinationCaller, maxFee, minFinalityThreshold).
 */
const CCTP_V2_DEPOSIT_FOR_BURN_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const

/**
 * CCTP V2 MessageTransmitter.receiveMessage selector.
 *
 *   receiveMessage(bytes message, bytes attestation) returns (bool)
 */
const CCTP_V2_RECEIVE_MESSAGE_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const

// --- Helpers ------------------------------------------------------------

const parseEvmChainId = (chainId: ChainId): bigint => {
  const s = String(chainId)
  if (!s.startsWith("evm:")) {
    throw new Error(`Not an EVM chain id: ${s}`)
  }
  const n = BigInt(s.slice(4))
  return n
}

const toHex = (n: bigint): Hex => `0x${n.toString(16)}` as Hex
const fromHex = (h: string): bigint => BigInt(h)
const toAddress = (s: string): Address => s as Address

const asBytes32 = (address: Address): Hex => {
  // left-pad a 20-byte address to 32 bytes, lowercase, 0x-prefixed
  const clean = address.toLowerCase().replace(/^0x/, "")
  return `0x${"0".repeat(64 - clean.length)}${clean}` as Hex
}

const emptyBytes32: Hex = `0x${"0".repeat(64)}` as Hex

// --- Factory ------------------------------------------------------------

export interface EvmAdapterOptions {
  readonly chainConfig: ChainConfig
  readonly fetcher: FetchAdapterShape
  readonly cctpContracts?: {
    readonly tokenMessenger: Address
    readonly messageTransmitter: Address
    readonly usdcToken: Address
    readonly version?: "v1" | "v2"
  }
}

export const makeEvmChainAdapter = (
  opts: EvmAdapterOptions,
): ChainAdapter => {
  const { chainConfig, fetcher, cctpContracts } = opts
  const rpcUrl = chainConfig.rpcUrl
  const chainIdBig = parseEvmChainId(chainConfig.chainId)

  const rpc = <T>(method: string, params: unknown = []) =>
    jsonRpcCall<T>(fetcher, rpcUrl, method, params)

  const buildErc20TransferData = (to: Address, amount: bigint): Hex =>
    encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, amount],
    })

  const buildErc20BalanceOfData = (owner: Address): Hex =>
    encodeFunctionData({
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [owner],
    })

  const failEst = (cause: unknown): FeeEstimationError =>
    new FeeEstimationError({ chain: String(chainConfig.chainId), cause })

  /**
   * Fetch gas, fees and nonce in parallel, preferring EIP-1559 fees
   * (`eth_maxPriorityFeePerGas` + latest `baseFeePerGas` from
   * `eth_getBlockByNumber`) and falling back to legacy `eth_gasPrice`
   * when the RPC does not support the 1559 methods.
   */
  const enrichPayloadWithFees = (
    payload: EvmCallPayload,
    from: string,
  ): Effect.Effect<EvmCallPayload, FeeEstimationError> =>
    Effect.gen(function* () {
      const estimateGas = rpc<string>("eth_estimateGas", [
        {
          from,
          to: payload.to,
          value: toHex(payload.value),
          data: payload.data,
        },
      ]).pipe(Effect.catchAll((c) => Effect.fail(failEst(c))))

      const nonceCall = rpc<string>("eth_getTransactionCount", [
        from,
        "pending",
      ]).pipe(Effect.catchAll((c) => Effect.fail(failEst(c))))

      // Try EIP-1559 path: maxPriorityFeePerGas + latest block baseFee.
      const priorityFeeCall = rpc<string>(
        "eth_maxPriorityFeePerGas",
        [],
      ).pipe(Effect.option)
      const latestBlockCall = rpc<{ baseFeePerGas?: string } | null>(
        "eth_getBlockByNumber",
        ["latest", false],
      ).pipe(Effect.option)

      const [gasHex, nonceHex, priorityOpt, blockOpt] = yield* Effect.all(
        [estimateGas, nonceCall, priorityFeeCall, latestBlockCall],
        { concurrency: "unbounded" },
      )

      const priorityHex =
        priorityOpt._tag === "Some" ? priorityOpt.value : undefined
      const block = blockOpt._tag === "Some" ? blockOpt.value : null
      const baseFeeHex = block?.baseFeePerGas

      const gas = fromHex(gasHex)
      const nonce = Number(fromHex(nonceHex))

      if (priorityHex !== undefined && baseFeeHex !== undefined) {
        const priority = fromHex(priorityHex)
        const baseFee = fromHex(baseFeeHex)
        // 2x baseFee is the common "safe max" heuristic used by wallets.
        const maxFeePerGas = baseFee * 2n + priority
        return {
          ...payload,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas: priority,
          nonce,
        } satisfies EvmCallPayload
      }

      // Legacy fallback.
      const gasPriceHex = yield* rpc<string>("eth_gasPrice", []).pipe(
        Effect.catchAll((c) => Effect.fail(failEst(c))),
      )
      return {
        ...payload,
        gas,
        gasPrice: fromHex(gasPriceHex),
        nonce,
      } satisfies EvmCallPayload
    })

  /**
   * Build the viem `TransactionSerializable` object from our payload.
   * Shared by `buildSigningMessage`, `attachSignature`, and the legacy
   * `sign()` helper.
   */
  const toSerializable = (
    tx: UnsignedTx,
  ): TransactionSerializable | undefined => {
    const payload = tx.payload as EvmCallPayload
    if (payload.gas === undefined) return undefined
    if (
      payload.maxFeePerGas !== undefined &&
      payload.maxPriorityFeePerGas !== undefined
    ) {
      return {
        to: payload.to,
        value: payload.value,
        data: payload.data,
        chainId: Number(chainIdBig),
        gas: payload.gas,
        maxFeePerGas: payload.maxFeePerGas,
        maxPriorityFeePerGas: payload.maxPriorityFeePerGas,
        nonce: payload.nonce ?? 0,
        type: "eip1559",
      } satisfies TransactionSerializableEIP1559
    }
    if (payload.gasPrice === undefined) return undefined
    return {
      to: payload.to,
      value: payload.value,
      data: payload.data,
      chainId: Number(chainIdBig),
      gas: payload.gas,
      gasPrice: payload.gasPrice,
      nonce: payload.nonce ?? 0,
      type: "legacy",
    }
  }

  const adapter: ChainAdapter = {
    chainId: chainConfig.chainId,

    deriveAddress: (publicKey) =>
      Effect.try({
        try: () => {
          // Uncompressed pubkey (64 bytes, no 0x04 prefix) -> keccak -> last 20 bytes.
          if (publicKey.length !== 64) {
            throw new Error(
              `EVM derivation needs uncompressed pubkey (64 bytes), got ${publicKey.length}`,
            )
          }
          const hashHex = keccak256(`0x${bytesToHex(publicKey)}` as Hex)
          return `0x${hashHex.slice(2 + 24)}`
        },
        catch: (e) =>
          new UnsupportedChainError({
            chain: `${String(chainConfig.chainId)}: ${(e as Error).message}`,
          }),
      }),

    buildTransferTx: ({ from, to, asset, amount }) =>
      Effect.gen(function* () {
        let payload: EvmCallPayload
        if (asset.type === "native") {
          payload = {
            kind: "direct-transfer",
            to: toAddress(to),
            value: amount,
            data: "0x" as Hex,
            asset,
          }
        } else {
          if (!asset.address) {
            return yield* Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause: "ERC20 transfer requires asset.address",
              }),
            )
          }
          payload = {
            kind: "contract-call",
            to: toAddress(asset.address),
            value: 0n,
            data: buildErc20TransferData(toAddress(to), amount),
            asset,
          }
        }

        const enriched = yield* enrichPayloadWithFees(payload, from)
        const totalFee =
          enriched.maxFeePerGas !== undefined
            ? enriched.gas! * enriched.maxFeePerGas
            : enriched.gas! * (enriched.gasPrice ?? 0n)

        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from,
          payload: enriched,
          estimatedFee: totalFee,
          metadata: {
            intent: `Transfer ${amount} ${asset.symbol} to ${to}`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    estimateFee: (tx) =>
      Effect.gen(function* () {
        const payload = tx.payload as EvmCallPayload
        if (
          payload.gas !== undefined &&
          payload.maxFeePerGas !== undefined
        ) {
          return payload.gas * payload.maxFeePerGas
        }
        if (payload.gas !== undefined && payload.gasPrice !== undefined) {
          return payload.gas * payload.gasPrice
        }
        const enriched = yield* enrichPayloadWithFees(payload, tx.from)
        if (enriched.maxFeePerGas !== undefined) {
          return enriched.gas! * enriched.maxFeePerGas
        }
        return enriched.gas! * (enriched.gasPrice ?? 0n)
      }),

    buildSigningMessage: (tx) =>
      Effect.gen(function* () {
        const serializable = toSerializable(tx)
        if (!serializable) {
          return yield* Effect.fail(
            failEst(
              "EVM buildSigningMessage requires a payload with gas + fee fields",
            ),
          )
        }
        // Digest that secp256k1 must sign: keccak256 of the unsigned
        // serialized tx, per EIP-155 / EIP-1559.
        const unsignedHex = serializeTransaction(serializable)
        const digestHex = keccak256(unsignedHex)
        return hexToBytes(digestHex.slice(2))
      }),

    attachSignature: (tx, signature, _publicKey) =>
      Effect.gen(function* () {
        const serializable = toSerializable(tx)
        if (!serializable) {
          return yield* Effect.fail(
            failEst(
              "EVM attachSignature requires a payload with gas + fee fields",
            ),
          )
        }
        if (signature.length !== 65) {
          return yield* Effect.fail(
            failEst(
              `EVM signature must be 65 bytes (r||s||v), got ${signature.length}`,
            ),
          )
        }
        const r = `0x${bytesToHex(signature.slice(0, 32))}` as Hex
        const s = `0x${bytesToHex(signature.slice(32, 64))}` as Hex
        const recovery = signature[64] === 1 ? 1 : 0
        // EIP-1559 wants yParity (0 or 1); legacy wants EIP-155 v =
        // chainId*2 + 35 + recovery.
        let signedHex: Hex
        if (serializable.type === "eip1559") {
          signedHex = serializeTransaction(serializable, {
            r,
            s,
            yParity: recovery as 0 | 1,
          })
        } else {
          const v = BigInt(recovery) + chainIdBig * 2n + 35n
          signedHex = serializeTransaction(serializable, { r, s, v })
        }
        const hash = keccak256(signedHex)
        const raw = hexToBytes(signedHex.slice(2))
        const signed: SignedTx = {
          chain: tx.chain,
          raw,
          hash,
          unsigned: tx,
        }
        return signed
      }),

    sign: (tx, privateKey) =>
      Effect.gen(function* () {
        // Convenience — used only by adapter-level unit tests. The
        // production path goes through SignerService + KeyringService.
        const digest = yield* adapter.buildSigningMessage(tx).pipe(
          Effect.catchAll((e) =>
            Effect.die(
              new Error(`EVM sign: buildSigningMessage failed: ${e.cause}`),
            ),
          ),
        )
        const sig = secp256k1.sign(digest, privateKey)
        const sigBytes = new Uint8Array(65)
        sigBytes.set(sig.toCompactRawBytes(), 0)
        sigBytes[64] = sig.recovery ?? 0
        return yield* adapter
          .attachSignature(tx, sigBytes, new Uint8Array(0))
          .pipe(
            Effect.catchAll((e) =>
              Effect.die(
                new Error(`EVM sign: attachSignature failed: ${e.cause}`),
              ),
            ),
          )
      }),

    buildCallTx: (req) =>
      Effect.gen(function* () {
        if (req.kind !== "evm") {
          return yield* Effect.fail(
            new UnsupportedChainError({
              chain: `EVM adapter received non-EVM CallRequest kind=${req.kind}`,
            }),
          )
        }
        if (!String(req.chain).startsWith("evm:")) {
          return yield* Effect.fail(
            new UnsupportedChainError({
              chain: `EVM adapter cannot build call for chain ${String(
                req.chain,
              )}`,
            }),
          )
        }

        const base: EvmCallPayload = {
          kind: "contract-call",
          to: toAddress(req.to),
          value: req.value ?? 0n,
          data: (req.data ?? "0x") as Hex,
          gas: req.gas,
          maxFeePerGas: req.maxFeePerGas,
          maxPriorityFeePerGas: req.maxPriorityFeePerGas,
          gasPrice: req.gasPrice,
          nonce: req.nonce,
        }

        const needsRpc =
          base.gas === undefined ||
          base.nonce === undefined ||
          (base.maxFeePerGas === undefined && base.gasPrice === undefined)

        let enriched: EvmCallPayload = base
        if (needsRpc) {
          const fetched = yield* enrichPayloadWithFees(base, req.from)
          // enrichPayloadWithFees overwrites; re-apply caller overrides
          // so user-supplied gas / fee / nonce win over RPC defaults.
          enriched = {
            ...fetched,
            gas: req.gas ?? fetched.gas,
            maxFeePerGas: req.maxFeePerGas ?? fetched.maxFeePerGas,
            maxPriorityFeePerGas:
              req.maxPriorityFeePerGas ?? fetched.maxPriorityFeePerGas,
            gasPrice: req.gasPrice ?? fetched.gasPrice,
            nonce: req.nonce ?? fetched.nonce,
          }
        }

        const totalFee =
          enriched.maxFeePerGas !== undefined
            ? enriched.gas! * enriched.maxFeePerGas
            : enriched.gas! * (enriched.gasPrice ?? 0n)

        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from: req.from,
          payload: enriched,
          estimatedFee: totalFee,
          metadata: {
            intent:
              req.label ??
              `Call ${req.to} on ${String(chainConfig.chainId)}`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    simulateCall: (req) =>
      Effect.gen(function* () {
        if (req.kind !== "evm") {
          return yield* Effect.fail(
            new UnsupportedChainError({
              chain: `EVM adapter received non-EVM CallRequest kind=${req.kind}`,
            }),
          )
        }
        const callObj: {
          from: string
          to: string
          data: Hex
          value?: Hex
        } = {
          from: req.from,
          to: req.to,
          data: (req.data ?? "0x") as Hex,
        }
        if (req.value !== undefined && req.value > 0n) {
          callObj.value = toHex(req.value)
        }

        // Use a raw RPC call so we can read `error.data` (the revert
        // payload) — jsonRpcCall collapses the error object into a
        // message string, which is insufficient for decoding.
        const json = yield* Effect.gen(function* () {
          const res = yield* fetcher.request({
            url: rpcUrl,
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [callObj, "latest"],
            }),
          })
          return yield* res.json<{
            result?: string
            error?: { code: number; message: string; data?: string }
          }>()
        }).pipe(Effect.catchAll((cause) => Effect.fail(failEst(cause))))

        if (!json.error && typeof json.result === "string") {
          return {
            success: true,
            returnData: json.result as Hex,
          } satisfies CallSimulation
        }

        const err = json.error
        const dataHex = err?.data
        let revertReason: string | undefined
        if (dataHex && dataHex !== "0x") {
          try {
            const decoded = decodeErrorResult({
              abi: [
                {
                  type: "error",
                  name: "Error",
                  inputs: [{ name: "message", type: "string" }],
                },
              ],
              data: dataHex as Hex,
            })
            if (decoded.errorName === "Error") {
              revertReason = String(decoded.args?.[0] ?? "")
            } else {
              revertReason = dataHex
            }
          } catch {
            revertReason = dataHex
          }
        } else if (err?.message) {
          revertReason = err.message
        }
        return {
          success: false,
          revertReason: revertReason ?? "reverted",
          raw: err ?? undefined,
        } satisfies CallSimulation
      }),

    buildCctpBurnTx: ({ from, destinationDomain, recipient, amount }) =>
      Effect.gen(function* () {
        if (!cctpContracts) {
          return yield* Effect.fail(
            new UnsupportedRouteError({
              from: String(chainConfig.chainId),
              to: `cctp:${destinationDomain}`,
              asset: "USDC",
            }),
          )
        }
        const initial = buildEvmCctpBurnTx(chainConfig, cctpContracts, {
          from,
          recipient: toAddress(recipient),
          amount,
          destinationDomain,
        })
        const basePayload = initial.payload as EvmCallPayload
        const enriched = yield* enrichPayloadWithFees(basePayload, from)
        const totalFee =
          enriched.maxFeePerGas !== undefined
            ? enriched.gas! * enriched.maxFeePerGas
            : enriched.gas! * (enriched.gasPrice ?? 0n)
        return {
          ...initial,
          payload: enriched,
          estimatedFee: totalFee,
        } satisfies UnsignedTx
      }),

    broadcast: (signed) =>
      Effect.gen(function* () {
        const rawHex = `0x${bytesToHex(signed.raw)}` as Hex
        const txHashResult = yield* rpc<string>("eth_sendRawTransaction", [
          rawHex,
        ]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new BroadcastError({
                chain: String(chainConfig.chainId),
                hash: signed.hash,
                cause,
              }),
            ),
          ),
        )
        const hash = txHashResult
        // Poll for receipt. We keep this simple and bounded: up to ~30s.
        const start = Date.now()
        const maxMs = 30_000
        const intervalMs = 1_000
        while (Date.now() - start < maxMs) {
          const receipt = yield* rpc<{
            status: string
            blockNumber: string
            gasUsed: string
          } | null>("eth_getTransactionReceipt", [hash]).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (receipt) {
            const status = receipt.status === "0x1" ? "confirmed" : "failed"
            return {
              chain: chainConfig.chainId,
              hash,
              status,
              blockNumber: fromHex(receipt.blockNumber),
              fee: fromHex(receipt.gasUsed),
              raw: receipt,
            } satisfies TxReceipt
          }
          yield* Effect.sleep(intervalMs)
        }
        return yield* Effect.fail(
          new BroadcastError({
            chain: String(chainConfig.chainId),
            hash,
            cause: "receipt poll timed out",
          }),
        )
      }),

    getBalance: (address, asset) =>
      Effect.gen(function* () {
        if (asset.type === "native") {
          const hex = yield* rpc<string>("eth_getBalance", [
            address,
            "latest",
          ]).pipe(Effect.catchAll(() => Effect.succeed("0x0")))
          return fromHex(hex)
        }
        if (!asset.address) return 0n
        const data = buildErc20BalanceOfData(toAddress(address))
        const hex = yield* rpc<string>("eth_call", [
          { to: asset.address, data },
          "latest",
        ]).pipe(Effect.catchAll(() => Effect.succeed("0x0")))
        return fromHex(hex === "0x" ? "0x0" : hex)
      }),

    getAllBalances: (address) =>
      Effect.gen(function* () {
        // We only know the native asset by default. Consumers who want
        // ERC20 balances must call getBalance() with a specific AssetId.
        const hex = yield* rpc<string>("eth_getBalance", [
          address,
          "latest",
        ]).pipe(Effect.catchAll(() => Effect.succeed("0x0")))
        const out: TokenBalance[] = [
          {
            asset: chainConfig.nativeAsset,
            balance: fromHex(hex),
            address,
          },
        ]
        return out
      }),

    extractBurnMessage: (receipt) =>
      Effect.gen(function* () {
        // The MessageTransmitter emits a `MessageSent(bytes message)` event.
        // Its topic hash is keccak256("MessageSent(bytes)") =
        //   0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036
        const MESSAGE_SENT_TOPIC =
          "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036"
        const raw = receipt.raw as { logs?: Array<{ topics: string[]; data: string }> } | null
        if (!raw || !raw.logs) {
          return yield* Effect.fail(
            new BroadcastError({
              chain: String(chainConfig.chainId),
              hash: receipt.hash,
              cause: "no logs in receipt",
            }),
          )
        }
        const log = raw.logs.find((l) => l.topics[0] === MESSAGE_SENT_TOPIC)
        if (!log) {
          return yield* Effect.fail(
            new BroadcastError({
              chain: String(chainConfig.chainId),
              hash: receipt.hash,
              cause: "no MessageSent log in receipt",
            }),
          )
        }
        // The event data is ABI-encoded: offset (32) + length (32) + bytes.
        // We decode the dynamic-bytes payload.
        const dataHex = log.data.startsWith("0x") ? log.data.slice(2) : log.data
        const len = parseInt(dataHex.slice(64, 128), 16)
        const messageHex = dataHex.slice(128, 128 + len * 2)
        const messageBytes = hexToBytes(messageHex)
        const messageHash = keccak256(`0x${messageHex}` as Hex).slice(2)
        const burn: BurnMessage = {
          sourceDomain: chainConfig.cctpDomain ?? 0,
          destDomain: 0,
          nonce: 0n,
          burnTxHash: receipt.hash,
          messageBytes,
          messageHash,
        }
        return burn
      }),

    buildMintTx: ({ recipient, messageBytes, attestation }) =>
      Effect.gen(function* () {
        if (!cctpContracts) {
          return yield* Effect.fail(
            new FeeEstimationError({
              chain: String(chainConfig.chainId),
              cause: "CCTP contracts not configured for this chain",
            }),
          )
        }
        const attestationHex = attestation.startsWith("0x")
          ? attestation
          : `0x${attestation}`
        const data = encodeFunctionData({
          abi: CCTP_V2_RECEIVE_MESSAGE_ABI,
          functionName: "receiveMessage",
          args: [
            `0x${bytesToHex(messageBytes)}` as Hex,
            attestationHex as Hex,
          ],
        })
        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from: recipient,
          payload: {
            kind: "cctp-mint",
            to: cctpContracts.messageTransmitter,
            value: 0n,
            data,
          } satisfies EvmCallPayload,
          estimatedFee: 200_000n * 20_000_000_000n, // rough upper bound
          metadata: {
            intent: `CCTP mint on ${String(chainConfig.chainId)}`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),
  }

  return adapter
}

/**
 * Build a CCTP depositForBurn transaction on an EVM chain.
 * Supports both V1 (4 params) and V2 (7 params). V2 is the
 * default; pass `version: "v1"` for chains still on V1 (e.g.
 * when burning to Aptos).
 */
export const buildEvmCctpBurnTx = (
  chainConfig: ChainConfig,
  cctpContracts: {
    readonly tokenMessenger: Address
    readonly messageTransmitter: Address
    readonly usdcToken: Address
    readonly version?: "v1" | "v2"
  },
  params: {
    readonly from: string
    readonly recipient: Address
    readonly amount: bigint
    readonly destinationDomain: number
  },
): UnsignedTx => {
  const isV1 = cctpContracts.version === "v1"
  const data = isV1
    ? encodeFunctionData({
        abi: CCTP_V1_DEPOSIT_FOR_BURN_ABI,
        functionName: "depositForBurn",
        args: [
          params.amount,
          params.destinationDomain,
          asBytes32(params.recipient),
          cctpContracts.usdcToken,
        ],
      })
    : encodeFunctionData({
        abi: CCTP_V2_DEPOSIT_FOR_BURN_ABI,
        functionName: "depositForBurn",
        args: [
          params.amount,
          params.destinationDomain,
          asBytes32(params.recipient),
          cctpContracts.usdcToken,
          emptyBytes32,
          params.amount / 1000n,
          1000,
        ],
      })
  const payload: EvmCallPayload = {
    kind: "cctp-burn",
    to: cctpContracts.tokenMessenger,
    value: 0n,
    data,
  }
  return {
    chain: chainConfig.chainId,
    from: params.from,
    payload,
    estimatedFee: 200_000n * 20_000_000_000n,
    metadata: {
      intent: `CCTP ${isV1 ? "V1" : "V2"} burn ${params.amount} USDC`,
      createdAt: Date.now(),
    },
  }
}

/**
 * Re-export viem's serialize/parse helpers for callers that want to
 * inspect raw signed EVM transactions.
 */
export { serializeTransaction, parseTransaction }
