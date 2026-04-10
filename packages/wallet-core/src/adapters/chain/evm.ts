import { Effect } from "effect"
import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializable,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainConfig, ChainId } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  UnsupportedChainError,
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
 * Signing uses viem's `privateKeyToAccount.signTransaction` which is
 * pure JS (secp256k1 via @noble/curves).
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
  /** Optional — filled in by estimateFee if not pre-specified. */
  readonly gas?: bigint
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
 * CCTP V2 TokenMessenger.depositForBurn selector. The architecture
 * references CCTP V2 so we use its signature.
 *
 *   depositForBurn(
 *     uint256 amount,
 *     uint32 destinationDomain,
 *     bytes32 mintRecipient,
 *     address burnToken,
 *     bytes32 destinationCaller,
 *     uint256 maxFee,
 *     uint32 minFinalityThreshold
 *   )
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

        // Estimate gas + fetch gas price in parallel.
        const [gas, gasPrice, nonceHex] = yield* Effect.all(
          [
            rpc<string>("eth_estimateGas", [
              {
                from,
                to: payload.to,
                value: toHex(payload.value),
                data: payload.data,
              },
            ]).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(
                  new FeeEstimationError({
                    chain: String(chainConfig.chainId),
                    cause,
                  }),
                ),
              ),
            ),
            rpc<string>("eth_gasPrice", []).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(
                  new FeeEstimationError({
                    chain: String(chainConfig.chainId),
                    cause,
                  }),
                ),
              ),
            ),
            rpc<string>("eth_getTransactionCount", [from, "pending"]).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(
                  new FeeEstimationError({
                    chain: String(chainConfig.chainId),
                    cause,
                  }),
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        )

        const finalGas = fromHex(gas)
        const finalGasPrice = fromHex(gasPrice)
        const nonce = Number(fromHex(nonceHex))

        const tx: UnsignedTx = {
          chain: chainConfig.chainId,
          from,
          payload: {
            ...payload,
            gas: finalGas,
            gasPrice: finalGasPrice,
            nonce,
          } satisfies EvmCallPayload,
          estimatedFee: finalGas * finalGasPrice,
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
        if (payload.gas !== undefined && payload.gasPrice !== undefined) {
          return payload.gas * payload.gasPrice
        }
        const gasHex = yield* rpc<string>("eth_estimateGas", [
          {
            from: tx.from,
            to: payload.to,
            value: toHex(payload.value),
            data: payload.data,
          },
        ]).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )
        const gasPriceHex = yield* rpc<string>("eth_gasPrice", []).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(
              new FeeEstimationError({
                chain: String(chainConfig.chainId),
                cause,
              }),
            ),
          ),
        )
        return fromHex(gasHex) * fromHex(gasPriceHex)
      }),

    sign: (tx, privateKey) =>
      Effect.tryPromise({
        try: async () => {
          const payload = tx.payload as EvmCallPayload
          if (payload.gas === undefined || payload.gasPrice === undefined) {
            throw new Error(
              "EVM sign requires a payload with gas + gasPrice — call estimateFee first",
            )
          }
          const account = privateKeyToAccount(
            `0x${bytesToHex(privateKey)}` as Hex,
          )
          const serializable: TransactionSerializable = {
            to: payload.to,
            value: payload.value,
            data: payload.data,
            chainId: Number(chainIdBig),
            gas: payload.gas,
            gasPrice: payload.gasPrice,
            nonce: payload.nonce ?? 0,
            type: "legacy",
          }
          const signedHex = await account.signTransaction(serializable)
          const hash = keccak256(signedHex)
          const raw = hexToBytes(signedHex.slice(2))
          const signed: SignedTx = {
            chain: tx.chain,
            raw,
            hash,
            unsigned: tx,
          }
          return signed
        },
        catch: (e) => e as Error,
      }).pipe(
        Effect.catchAll((e) =>
          Effect.die(new Error(`EVM sign failed: ${(e as Error).message}`)),
        ),
      ),

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
 * Build a CCTP V2 depositForBurn transaction on an EVM chain.
 * Exported for CctpService so it can wire the burn step without
 * reaching into adapter internals.
 */
export const buildEvmCctpBurnTx = (
  chainConfig: ChainConfig,
  cctpContracts: {
    readonly tokenMessenger: Address
    readonly messageTransmitter: Address
    readonly usdcToken: Address
  },
  params: {
    readonly from: string
    readonly recipient: Address
    readonly amount: bigint
    readonly destinationDomain: number
  },
): UnsignedTx => {
  const data = encodeFunctionData({
    abi: CCTP_V2_DEPOSIT_FOR_BURN_ABI,
    functionName: "depositForBurn",
    args: [
      params.amount,
      params.destinationDomain,
      asBytes32(params.recipient),
      cctpContracts.usdcToken,
      emptyBytes32, // destinationCaller = allow any
      params.amount / 1000n, // maxFee = 0.1%
      1000, // minFinalityThreshold — soft finality
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
      intent: `CCTP burn ${params.amount} USDC`,
      createdAt: Date.now(),
    },
  }
}

/**
 * Re-export viem's serialize/parse helpers for callers that want to
 * inspect raw signed EVM transactions.
 */
export { serializeTransaction, parseTransaction }
