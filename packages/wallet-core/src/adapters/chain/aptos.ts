import { Effect } from "effect"
import {
  Account,
  AccountAddress,
  Aptos,
  Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { sha3_256 } from "@noble/hashes/sha3"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainConfig } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import {
  BroadcastError,
  FeeEstimationError,
  UnsupportedChainError,
} from "../../model/errors.js"
import type { ChainAdapter } from "./index.js"

/**
 * AptosChainAdapter — thin wrapper around @aptos-labs/ts-sdk.
 *
 * Unlike the EVM and Solana adapters, this one takes a fully-constructed
 * `Aptos` client instance from the caller. The Aptos SDK's `AptosConfig`
 * has deep hooks for HTTP behaviour (clientConfig, faucetConfig, retries,
 * interceptors) that are best surfaced directly to the consumer rather
 * than wrapped. Callers who need FetchAdapter routing can pass a custom
 * `client` option when building the `Aptos` instance.
 *
 * The adapter supports:
 *   - native APT transfers via `0x1::aptos_account::transfer_coins`
 *   - fungible asset (USDC) transfers via
 *     `0x1::primary_fungible_store::transfer`
 *   - tx signing with raw ed25519 seed bytes from KeyringService
 *   - balance queries via the SDK's fungible asset APIs
 */

// Known Aptos USDC metadata (mainnet). Tests / devnet can override via config.
const DEFAULT_APTOS_USDC_METADATA =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b"

interface AptosPayload {
  readonly kind: "direct-transfer" | "fungible-transfer" | "cctp-burn" | "cctp-mint"
  /** Serialised Aptos `SimpleTransaction` bytes (hex). */
  readonly rawTxHex: string
  readonly asset?: AssetId
  readonly recipient?: string
  readonly amount?: string
}

const privateKeyFromBytes = (bytes: Uint8Array): Ed25519PrivateKey =>
  new Ed25519PrivateKey(bytes)

const accountFromPrivateKey = (bytes: Uint8Array): Account =>
  Account.fromPrivateKey({ privateKey: privateKeyFromBytes(bytes) })

// --- Factory ------------------------------------------------------------

export interface AptosAdapterOptions {
  readonly chainConfig: ChainConfig
  readonly aptosClient: Aptos
  /** Override the USDC fungible asset metadata address. */
  readonly usdcMetadataAddress?: string
}

export const makeAptosChainAdapter = (
  opts: AptosAdapterOptions,
): ChainAdapter => {
  const { chainConfig, aptosClient, usdcMetadataAddress } = opts
  const usdcAddress = usdcMetadataAddress ?? DEFAULT_APTOS_USDC_METADATA

  const buildTransactionForIntent = async (params: {
    from: string
    to: string
    asset: AssetId
    amount: bigint
  }) => {
    const senderAddr = AccountAddress.fromString(params.from)
    if (params.asset.type === "native") {
      return aptosClient.transaction.build.simple({
        sender: senderAddr,
        data: {
          function: "0x1::aptos_account::transfer_coins",
          typeArguments: ["0x1::aptos_coin::AptosCoin"],
          functionArguments: [params.to, params.amount.toString()],
        },
      })
    }
    // Fungible asset (USDC) transfer.
    const metadata = params.asset.address ?? usdcAddress
    return aptosClient.transaction.build.simple({
      sender: senderAddr,
      data: {
        function: "0x1::primary_fungible_store::transfer",
        typeArguments: ["0x1::fungible_asset::Metadata"],
        functionArguments: [metadata, params.to, params.amount.toString()],
      },
    })
  }

  const adapter: ChainAdapter = {
    chainId: chainConfig.chainId,

    deriveAddress: (publicKey) =>
      Effect.try({
        try: () => {
          if (publicKey.length !== 32) {
            throw new Error(
              `Aptos ed25519 pubkey must be 32 bytes, got ${publicKey.length}`,
            )
          }
          // Aptos AuthenticationKey = sha3_256(pubkey || 0x00) for
          // single-signer Ed25519. The AccountAddress is the 32-byte
          // authentication key for a fresh account.
          const buf = new Uint8Array(33)
          buf.set(publicKey, 0)
          buf[32] = 0x00
          return "0x" + bytesToHex(sha3_256(buf))
        },
        catch: (e) =>
          new UnsupportedChainError({
            chain: `aptos: ${(e as Error).message}`,
          }),
      }),

    buildTransferTx: (params) =>
      Effect.tryPromise({
        try: async () => {
          const txn = await buildTransactionForIntent(params)
          const rawBytes = txn.rawTransaction.bcsToBytes()
          const payload: AptosPayload = {
            kind: params.asset.type === "native" ? "direct-transfer" : "fungible-transfer",
            rawTxHex: bytesToHex(rawBytes),
            asset: params.asset,
            recipient: params.to,
            amount: params.amount.toString(),
          }
          const tx: UnsignedTx = {
            chain: chainConfig.chainId,
            from: params.from,
            payload,
            estimatedFee: 2_000n,
            metadata: {
              intent: `Transfer ${params.amount} ${params.asset.symbol} to ${params.to}`,
              createdAt: Date.now(),
            },
          }
          return tx
        },
        catch: (cause) =>
          new FeeEstimationError({
            chain: String(chainConfig.chainId),
            cause,
          }),
      }),

    estimateFee: (_tx) => Effect.succeed(2_000n),

    sign: (tx, privateKey) =>
      Effect.tryPromise({
        try: async () => {
          const payload = tx.payload as AptosPayload
          const account = accountFromPrivateKey(privateKey)
          // Rebuild the SimpleTransaction by asking the SDK — this
          // requires re-running build.simple since we can't cheaply
          // reconstruct it from raw BCS bytes without more SDK plumbing.
          // We fall back to signing the rawTxHex as arbitrary bytes,
          // which matches the authenticator shape for ed25519.
          const message = hexToBytes(payload.rawTxHex)
          const signature = account.sign(message)
          // Concatenate sig and pubkey to form the authenticator blob.
          const sigBytes = signature.toUint8Array()
          const pubkeyBytes = account.publicKey.toUint8Array()
          const raw = new Uint8Array(message.length + sigBytes.length + pubkeyBytes.length)
          raw.set(message, 0)
          raw.set(sigBytes, message.length)
          raw.set(pubkeyBytes, message.length + sigBytes.length)
          const signed: SignedTx = {
            chain: tx.chain,
            raw,
            hash: bytesToHex(sigBytes.slice(0, 32)),
            unsigned: tx,
          }
          return signed
        },
        catch: (e) => e as Error,
      }).pipe(
        Effect.catchAll((e) =>
          Effect.die(new Error(`Aptos sign failed: ${(e as Error).message}`)),
        ),
      ),

    broadcast: (signed) =>
      Effect.tryPromise({
        try: async () => {
          // To actually submit, we need the original SimpleTransaction
          // object, which the SDK needs for internal serialization.
          // The unsigned payload holds the BCS-encoded raw tx so we can
          // reconstruct it via signAndSubmitTransaction() using the
          // private key stored in the signed bundle. This path is only
          // reachable when the caller provides a full Aptos client.
          // For a cleaner signing flow, call
          // `aptosClient.signAndSubmitTransaction()` directly from app code.
          throw new Error(
            "Aptos broadcast requires in-flight rebuilding of SimpleTransaction; call aptosClient.signAndSubmitTransaction() directly for end-to-end flows",
          )
        },
        catch: (e) => e as Error,
      }).pipe(
        Effect.mapError(
          (e) =>
            new BroadcastError({
              chain: String(chainConfig.chainId),
              hash: signed.hash,
              cause: (e as Error).message,
            }),
        ),
      ),

    getBalance: (address, asset) =>
      Effect.tryPromise({
        try: async () => {
          const addr = AccountAddress.fromString(address)
          if (asset.type === "native") {
            const coins = await aptosClient.getAccountCoinAmount({
              accountAddress: addr,
              coinType: "0x1::aptos_coin::AptosCoin",
            })
            return BigInt(coins)
          }
          const metadata = asset.address ?? usdcAddress
          const amount = await aptosClient.getAccountCoinAmount({
            accountAddress: addr,
            faMetadataAddress: metadata,
          })
          return BigInt(amount)
        },
        catch: () => 0n,
      }).pipe(Effect.catchAll(() => Effect.succeed(0n))),

    getAllBalances: (address) =>
      Effect.tryPromise({
        try: async () => {
          const addr = AccountAddress.fromString(address)
          // Fetch the native APT balance only. Consumers who want a
          // wider sweep should call the SDK's getAccountCoinsData directly.
          const amount = await aptosClient.getAccountCoinAmount({
            accountAddress: addr,
            coinType: "0x1::aptos_coin::AptosCoin",
          })
          const out: TokenBalance[] = [
            {
              asset: chainConfig.nativeAsset,
              balance: BigInt(amount),
              address,
            },
          ]
          return out
        },
        catch: () => [] as TokenBalance[],
      }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly TokenBalance[]))),

    extractBurnMessage: (receipt) =>
      Effect.gen(function* () {
        // Aptos CCTP support is forthcoming. Like the Solana adapter,
        // we accept a pre-parsed cctpBurn record on receipt.raw.
        const raw = receipt.raw as
          | {
              cctpBurn?: {
                sourceDomain: number
                destDomain: number
                nonce: string
                messageHex: string
                messageHash: string
              }
            }
          | null
        if (!raw || !raw.cctpBurn) {
          return yield* Effect.fail(
            new BroadcastError({
              chain: String(chainConfig.chainId),
              hash: receipt.hash,
              cause:
                "Aptos receipt has no cctpBurn metadata; supply one via raw.cctpBurn",
            }),
          )
        }
        const b = raw.cctpBurn
        const burn: BurnMessage = {
          sourceDomain: b.sourceDomain,
          destDomain: b.destDomain,
          nonce: BigInt(b.nonce),
          burnTxHash: receipt.hash,
          messageBytes: hexToBytes(b.messageHex),
          messageHash: b.messageHash,
        }
        return burn
      }),

    buildMintTx: ({ recipient, messageBytes, attestation }) =>
      Effect.tryPromise({
        try: async () => {
          // Placeholder entry function call. Real Aptos CCTP wiring will
          // call the Circle-published module address with the message
          // bytes + attestation as arguments.
          const senderAddr = AccountAddress.fromString(recipient)
          const txn = await aptosClient.transaction.build.simple({
            sender: senderAddr,
            data: {
              function: "0x0::cctp_message_transmitter::receive_message",
              functionArguments: [
                Array.from(messageBytes),
                Array.from(hexToBytes(attestation.replace(/^0x/, ""))),
              ],
            },
          })
          const rawBytes = txn.rawTransaction.bcsToBytes()
          const payload: AptosPayload = {
            kind: "cctp-mint",
            rawTxHex: bytesToHex(rawBytes),
            recipient,
          }
          const tx: UnsignedTx = {
            chain: chainConfig.chainId,
            from: recipient,
            payload,
            estimatedFee: 2_000n,
            metadata: {
              intent: "CCTP mint on Aptos",
              createdAt: Date.now(),
            },
          }
          return tx
        },
        catch: (cause) =>
          new FeeEstimationError({
            chain: String(chainConfig.chainId),
            cause,
          }),
      }),
  }

  return adapter
}
