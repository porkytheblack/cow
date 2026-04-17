import { Effect } from "effect"
import {
  AccountAddress,
  AccountAuthenticatorEd25519,
  Aptos,
  Deserializer,
  Ed25519PublicKey,
  Ed25519Signature,
  RawTransaction,
  SimpleTransaction,
  generateSigningMessageForTransaction,
} from "@aptos-labs/ts-sdk"
import { ed25519 } from "@noble/curves/ed25519"
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
  UnsupportedRouteError,
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
  /**
   * BCS-serialized Aptos `RawTransaction` bytes (hex). Re-hydrated into
   * a `SimpleTransaction` at signing and broadcast time.
   */
  readonly rawTxHex: string
  readonly asset?: AssetId
  readonly recipient?: string
  readonly amount?: string
}

const rehydrateSimpleTransaction = (rawTxHex: string): SimpleTransaction => {
  const bytes = hexToBytes(rawTxHex)
  const deserializer = new Deserializer(bytes)
  const rawTx = RawTransaction.deserialize(deserializer)
  return new SimpleTransaction(rawTx)
}

// --- Factory ------------------------------------------------------------

export interface AptosAdapterOptions {
  readonly chainConfig: ChainConfig
  readonly aptosClient: Aptos
  /** Override the USDC fungible asset metadata address. */
  readonly usdcMetadataAddress?: string
  /**
   * When true, every tx this adapter builds is treated as sponsored:
   *
   *   - `buildTransferTx` and `buildMintTx` pass `withFeePayer: true` to
   *     `aptosClient.transaction.build.simple(...)`, producing a
   *     `RawTransactionWithData::MultiAgentWithFeePayer` shape.
   *   - `UnsignedTx.estimatedFee` is 0n, so `SignerService` will not
   *     escalate the auth prompt via `elevatedThreshold`.
   *   - `broadcast` routes through the plugin on `aptosClient` (see below).
   *
   * The caller MUST have constructed `aptosClient` with a
   * `GasStationTransactionSubmitter` wired into
   * `pluginSettings.TRANSACTION_SUBMITTER` (see @aptos-labs/gas-station-client).
   *
   * If `sponsored: true` is set without the plugin, submission will fail at
   * the fullnode with `INVALID_SIGNATURE` or a missing-fee-payer error.
   * cow-wallet cannot detect this misconfiguration from its side.
   */
  readonly sponsored?: boolean
}

export const makeAptosChainAdapter = (
  opts: AptosAdapterOptions,
): ChainAdapter => {
  const { chainConfig, aptosClient, usdcMetadataAddress } = opts
  const sponsored = opts.sponsored ?? false
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
        // Sender signs with `fee_payer_address = 0x0` (framework 1.8+
        // wildcard). The gas-station plugin fills in the real fee-payer
        // at submit time; don't pre-fill one here.
        withFeePayer: sponsored,
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
      withFeePayer: sponsored,
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
            // Zero when sponsored so SignerService doesn't compare a real
            // fee against `auth.elevatedThreshold` — the user isn't paying.
            estimatedFee: sponsored ? 0n : 2_000n,
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

    estimateFee: (_tx) => Effect.succeed(sponsored ? 0n : 2_000n),

    buildSigningMessage: (tx) =>
      Effect.try({
        try: () => {
          const payload = tx.payload as AptosPayload
          const simple = rehydrateSimpleTransaction(payload.rawTxHex)
          // SDK-provided helper: prepends `sha3_256("APTOS::RawTransaction")`
          // to the BCS-encoded raw tx. KeyringService ed25519-signs the
          // result; the same helper is what `Account.signTransaction`
          // uses internally, so the resulting signature verifies.
          return generateSigningMessageForTransaction(simple)
        },
        catch: (cause) =>
          new FeeEstimationError({
            chain: String(chainConfig.chainId),
            cause,
          }),
      }),

    attachSignature: (tx, signature, publicKey) =>
      Effect.try({
        try: () => {
          if (signature.length !== 64) {
            throw new Error(
              `Aptos ed25519 signature must be 64 bytes, got ${signature.length}`,
            )
          }
          if (publicKey.length !== 32) {
            throw new Error(
              `Aptos ed25519 pubkey must be 32 bytes, got ${publicKey.length}`,
            )
          }
          const payload = tx.payload as AptosPayload
          const rawBytes = hexToBytes(payload.rawTxHex)
          // Signed Aptos tx blob = [tag(1) | rawTxLen(u32 LE) | rawTxBytes | pubkey(32) | sig(64)]
          // tag: 0x00 = unsponsored, 0x01 = sponsored. broadcast() reads
          // the tag so a sponsored blob accidentally submitted without
          // the plugin fails loudly instead of silently.
          const framing = new Uint8Array(1 + 4 + rawBytes.length + 32 + 64)
          let off = 0
          framing[off++] = sponsored ? 0x01 : 0x00
          const len = rawBytes.length
          framing[off++] = len & 0xff
          framing[off++] = (len >>> 8) & 0xff
          framing[off++] = (len >>> 16) & 0xff
          framing[off++] = (len >>> 24) & 0xff
          framing.set(rawBytes, off)
          off += rawBytes.length
          framing.set(publicKey, off)
          off += 32
          framing.set(signature, off)
          const signed: SignedTx = {
            chain: tx.chain,
            raw: framing,
            // Aptos tx hash = sha3_256(signing_message || sig-salt) but
            // we only need something uniquely identifying for tests and
            // telemetry; the real on-chain hash comes back from submit.
            hash: bytesToHex(signature.slice(0, 32)),
            unsigned: tx,
          }
          return signed
        },
        catch: (cause) =>
          new FeeEstimationError({
            chain: String(chainConfig.chainId),
            cause,
          }),
      }),

    sign: (tx, privateKey) =>
      Effect.gen(function* () {
        // Convenience for adapter-level tests. Sign via @noble/curves
        // directly so the adapter never stashes the key material.
        const msg = yield* adapter.buildSigningMessage(tx).pipe(
          Effect.catchAll((e) =>
            Effect.die(
              new Error(`Aptos sign: buildSigningMessage failed: ${e.cause}`),
            ),
          ),
        )
        const publicKey = ed25519.getPublicKey(privateKey)
        const signature = ed25519.sign(msg, privateKey)
        return yield* adapter
          .attachSignature(tx, signature, publicKey)
          .pipe(
            Effect.catchAll((e) =>
              Effect.die(
                new Error(`Aptos sign: attachSignature failed: ${e.cause}`),
              ),
            ),
          )
      }),

    broadcast: (signed) =>
      Effect.tryPromise({
        try: async () => {
          // Decode the framing produced by attachSignature:
          //   [tag(1) | rawTxLen(u32 LE) | rawTxBytes | pubkey(32) | sig(64)]
          const framing = signed.raw
          if (framing.length < 1) {
            throw new Error("Aptos signed tx framing is empty")
          }
          const tag = framing[0]!
          if (tag !== 0x00 && tag !== 0x01) {
            throw new Error(
              `unknown Aptos framing tag: 0x${tag.toString(16)}`,
            )
          }
          if (framing.length < 1 + 4 + 32 + 64) {
            throw new Error("Aptos signed tx framing is too short")
          }
          const len =
            framing[1]! |
            (framing[2]! << 8) |
            (framing[3]! << 16) |
            (framing[4]! << 24)
          if (framing.length !== 1 + 4 + len + 32 + 64) {
            throw new Error("Aptos signed tx framing length mismatch")
          }
          const rawBytes = framing.slice(5, 5 + len)
          const pubkeyBytes = framing.slice(5 + len, 5 + len + 32)
          const sigBytes = framing.slice(5 + len + 32)

          const simple = new SimpleTransaction(
            RawTransaction.deserialize(new Deserializer(rawBytes)),
          )
          const authenticator = new AccountAuthenticatorEd25519(
            new Ed25519PublicKey(pubkeyBytes),
            new Ed25519Signature(sigBytes),
          )

          // Sponsored vs unsponsored submit: the call shape is identical.
          // What differs is whether `aptosClient.config.pluginSettings
          // .TRANSACTION_SUBMITTER` is set. When it is, the plugin
          // intercepts submission, signs as fee payer, and combines
          // authenticators. cow-wallet never constructs a
          // feePayerAuthenticator and never passes one here.
          const pending = await aptosClient.transaction.submit.simple({
            transaction: simple,
            senderAuthenticator: authenticator,
          })
          const hash = pending.hash
          // Wait for inclusion; SDK helper polls until committed.
          // Keep this inside the try block so gas-station policy
          // rejections surface through BroadcastError.cause.
          await aptosClient.waitForTransaction({ transactionHash: hash })
          return {
            chain: chainConfig.chainId,
            hash,
            status: "confirmed",
            raw: pending,
          } satisfies TxReceipt
        },
        catch: (cause) =>
          new BroadcastError({
            chain: String(chainConfig.chainId),
            hash: signed.hash,
            cause,
          }),
      }),

    buildCctpBurnTx: (_params) =>
      Effect.fail(
        new UnsupportedRouteError({
          from: String(chainConfig.chainId),
          to: "cctp",
          asset: "USDC",
        }),
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
            withFeePayer: sponsored,
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
            estimatedFee: sponsored ? 0n : 2_000n,
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
