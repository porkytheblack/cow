import { Effect } from "effect"
import { bytesToHex } from "@noble/hashes/utils"
import { sha256 } from "@noble/hashes/sha256"
import type { AssetId } from "../../model/asset.js"
import type { TokenBalance } from "../../model/balance.js"
import type { CallRequest, CallSimulation } from "../../model/call.js"
import type { BurnMessage } from "../../model/cctp.js"
import type { ChainConfig } from "../../model/chain.js"
import type { SignedTx, TxReceipt, UnsignedTx } from "../../model/transaction.js"
import { BroadcastError } from "../../model/errors.js"
import type { ChainAdapter } from "./index.js"
import {
  publicKeyForChain,
  signMessageForChain,
} from "../../services/keyring-crypto.js"

interface MockState {
  readonly balances: Map<string, bigint> // key: `${address}::${symbol}`
  readonly receipts: Map<string, TxReceipt>
  nonceCounter: bigint
  /** Overrides the next simulateCall response. Consumed on use. */
  nextSimulation?: CallSimulation
  /**
   * Controls what `broadcast` does on the next call. `reject` forces it
   * to fail with a `BroadcastError`, optionally leaving a "landed"
   * receipt behind that `extractBurnMessageFromTx` will surface — the
   * racey-broadcast case we're guarding against in production.
   */
  nextBroadcastBehavior?: {
    reject: boolean
    landReceiptAnyway: boolean
  }
}

const balanceKey = (address: string, asset: AssetId) =>
  `${address}::${asset.symbol}`

const synthBurnFromReceipt = (
  config: ChainConfig,
  hash: string,
  raw: unknown,
): BurnMessage => {
  const payload = raw as {
    kind?: string
    destDomain?: number
    amount?: string
    recipient?: string
  }
  if (payload?.kind !== "cctp-burn") {
    throw new BroadcastError({
      chain: config.chainId,
      hash,
      cause: "receipt is not a CCTP burn",
    })
  }
  const messageBytes = new TextEncoder().encode(
    JSON.stringify({
      src: config.chainId,
      dstDomain: payload.destDomain,
      amount: payload.amount,
      recipient: payload.recipient,
      burnTxHash: hash,
    }),
  )
  const messageHash = bytesToHex(sha256(messageBytes))
  return {
    sourceDomain: config.cctpDomain ?? 0,
    destDomain: payload.destDomain ?? 0,
    nonce: BigInt("0x" + messageHash.slice(0, 16)),
    burnTxHash: hash,
    messageBytes,
    messageHash,
  }
}

/**
 * Deterministic mock chain adapter for tests. Keeps an in-memory ledger
 * of balances and accepts every transaction as "confirmed". Useful for
 * exercising the full Effect pipeline end-to-end without network calls.
 *
 * CCTP: parses burn payloads by inspection — each burn UnsignedTx payload
 * carries `{ kind: "cctp-burn", destChain, amount, recipient }`.
 */
export const makeMockChainAdapter = (config: ChainConfig): ChainAdapter => {
  const state: MockState = {
    balances: new Map(),
    receipts: new Map(),
    nonceCounter: 1n,
  }

  // Fund a default balance for the test wallet so transfers can go through.
  // Tests can override by writing to state.balances.
  const seedBalance = (address: string, asset: AssetId, amount: bigint) => {
    state.balances.set(balanceKey(address, asset), amount)
  }

  const getBalanceSync = (address: string, asset: AssetId): bigint =>
    state.balances.get(balanceKey(address, asset)) ?? 0n

  const hashOf = (data: Uint8Array): string => bytesToHex(sha256(data)).slice(0, 64)

  const adapter: ChainAdapter = {
    chainId: config.chainId,

    deriveAddress: (publicKey) =>
      Effect.succeed(
        // Deterministic synthetic address from public key + chain tag.
        // Real adapters delegate to their SDKs — this is shape-compatible.
        `${config.chainId}:${bytesToHex(sha256(publicKey)).slice(0, 40)}`,
      ),

    buildTransferTx: ({ from, to, asset, amount }) =>
      Effect.sync(() => {
        const tx: UnsignedTx = {
          chain: config.chainId,
          from,
          payload: {
            kind: "direct-transfer",
            to,
            asset,
            amount: amount.toString(),
          },
          estimatedFee: 1_000n,
          metadata: {
            intent: `Transfer ${amount} ${asset.symbol} to ${to}`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    estimateFee: (_tx) => Effect.succeed(1_000n),

    broadcast: (signed) =>
      Effect.sync(() => {
        const payload = signed.unsigned.payload as {
          kind: string
          to?: string
          asset?: AssetId
          amount?: string
          destDomain?: number
          recipient?: string
        }

        const behavior = state.nextBroadcastBehavior
        if (behavior) {
          state.nextBroadcastBehavior = undefined
          if (behavior.reject) {
            if (behavior.landReceiptAnyway) {
              // Simulate the Solana sendTransaction quirk: RPC returns an
              // error but the cluster actually accepted + executed the tx.
              // Stash a receipt so `extractBurnMessageFromTx` finds it.
              const landed: TxReceipt = {
                chain: config.chainId,
                hash: signed.hash,
                status: "confirmed",
                blockNumber: state.nonceCounter++,
                fee: 1_000n,
                raw: payload,
              }
              state.receipts.set(signed.hash, landed)
            }
            throw new BroadcastError({
              chain: config.chainId,
              hash: signed.hash,
              cause: "mock: broadcast rejected",
            })
          }
        }

        if (payload.kind === "direct-transfer" && payload.asset && payload.amount) {
          const amt = BigInt(payload.amount)
          const fromBal = getBalanceSync(signed.unsigned.from, payload.asset)
          if (fromBal < amt) {
            throw new BroadcastError({
              chain: config.chainId,
              hash: signed.hash,
              cause: `insufficient balance: ${fromBal} < ${amt}`,
            })
          }
          state.balances.set(
            balanceKey(signed.unsigned.from, payload.asset),
            fromBal - amt,
          )
          if (payload.to) {
            const toBal = getBalanceSync(payload.to, payload.asset)
            state.balances.set(balanceKey(payload.to, payload.asset), toBal + amt)
          }
        }

        const receipt: TxReceipt = {
          chain: config.chainId,
          hash: signed.hash,
          status: "confirmed",
          blockNumber: state.nonceCounter++,
          fee: 1_000n,
          raw: payload,
        }
        state.receipts.set(signed.hash, receipt)
        return receipt
      }).pipe(
        Effect.catchAllDefect((defect) =>
          defect instanceof BroadcastError
            ? Effect.fail(defect)
            : Effect.die(defect),
        ),
      ) as Effect.Effect<TxReceipt, BroadcastError>,

    getBalance: (address, asset) =>
      Effect.succeed(getBalanceSync(address, asset)),

    getAllBalances: (address) =>
      Effect.sync(() => {
        const out: TokenBalance[] = []
        for (const [k, v] of state.balances.entries()) {
          if (!k.startsWith(`${address}::`)) continue
          const symbol = k.slice(address.length + 2)
          out.push({
            asset: {
              chain: config.chainId,
              type: symbol === config.nativeAsset.symbol ? "native" : "token",
              symbol,
              decimals: 6,
            },
            balance: v,
            address,
          })
        }
        return out
      }),

    // The mock hashes the payload to a fixed 32-byte digest so the
    // same message can be signed by either ed25519 or secp256k1
    // (secp256k1 requires a 32-byte input); this mirrors what a real
    // chain adapter would do with its chain-specific digest.
    buildSigningMessage: (tx) =>
      Effect.sync(() =>
        sha256(new TextEncoder().encode(JSON.stringify(tx.payload))),
      ),

    attachSignature: (tx, signature, publicKey) =>
      Effect.sync(() => {
        const payloadBytes = new TextEncoder().encode(JSON.stringify(tx.payload))
        const raw = new Uint8Array(
          payloadBytes.length + signature.length + publicKey.length,
        )
        raw.set(payloadBytes, 0)
        raw.set(signature, payloadBytes.length)
        raw.set(publicKey, payloadBytes.length + signature.length)
        return {
          chain: tx.chain,
          raw,
          hash: hashOf(raw),
          unsigned: tx,
        }
      }),

    sign: (tx, privateKey) =>
      Effect.sync(() => {
        // Convenience for adapter-level tests only — mirrors the
        // three-step buildSigningMessage / sign / attachSignature flow
        // that SignerService uses in production.
        const digest = sha256(
          new TextEncoder().encode(JSON.stringify(tx.payload)),
        )
        const signature = signMessageForChain(
          String(tx.chain),
          digest,
          privateKey,
        )
        const publicKey = publicKeyForChain(String(tx.chain), privateKey)
        const payloadBytes = new TextEncoder().encode(JSON.stringify(tx.payload))
        const raw = new Uint8Array(
          payloadBytes.length + signature.length + publicKey.length,
        )
        raw.set(payloadBytes, 0)
        raw.set(signature, payloadBytes.length)
        raw.set(publicKey, payloadBytes.length + signature.length)
        return {
          chain: tx.chain,
          raw,
          hash: hashOf(raw),
          unsigned: tx,
        }
      }),

    buildCallTx: (req) =>
      Effect.sync(() => {
        const tx: UnsignedTx = {
          chain: config.chainId,
          from: req.from,
          payload: {
            kind: "contract-call",
            request: req,
          },
          estimatedFee: 1_500n,
          metadata: {
            intent:
              req.label ??
              `Call on ${String(config.chainId)} (kind=${req.kind})`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    simulateCall: (_req) =>
      Effect.sync(() => {
        if (state.nextSimulation) {
          const sim = state.nextSimulation
          state.nextSimulation = undefined
          return sim
        }
        return { success: true } satisfies CallSimulation
      }),

    buildCctpBurnTx: ({ from, destinationDomain, recipient, amount }) =>
      Effect.sync(() => {
        const tx: UnsignedTx = {
          chain: config.chainId,
          from,
          payload: {
            kind: "cctp-burn",
            destDomain: destinationDomain,
            amount: amount.toString(),
            recipient,
          },
          estimatedFee: 2_000n,
          metadata: {
            intent: `CCTP burn ${amount} USDC (domain ${destinationDomain})`,
            createdAt: Date.now(),
          },
        }
        return tx
      }),

    extractBurnMessage: (receipt) =>
      Effect.sync(() =>
        synthBurnFromReceipt(config, receipt.hash, receipt.raw),
      ).pipe(
        Effect.catchAllDefect((defect) =>
          defect instanceof BroadcastError
            ? Effect.fail(defect)
            : Effect.die(defect),
        ),
      ) as Effect.Effect<BurnMessage, BroadcastError>,

    extractBurnMessageFromTx: (hash) =>
      Effect.sync(() => {
        const receipt = state.receipts.get(hash)
        if (!receipt) return null
        try {
          return synthBurnFromReceipt(config, hash, receipt.raw)
        } catch {
          return null
        }
      }),

    buildMintTx: ({ recipient, messageBytes, attestation }) =>
      Effect.sync(() => ({
        chain: config.chainId,
        from: recipient,
        payload: {
          kind: "cctp-mint",
          messageBytes: bytesToHex(messageBytes),
          attestation,
          recipient,
        },
        estimatedFee: 1_000n,
        metadata: {
          intent: `CCTP mint to ${recipient}`,
          createdAt: Date.now(),
        },
      })),
  }

  const seedSimulation = (sim: CallSimulation) => {
    state.nextSimulation = sim
  }

  const seedBroadcastBehavior = (
    behavior: { reject: boolean; landReceiptAnyway: boolean } | undefined,
  ) => {
    state.nextBroadcastBehavior = behavior
  }

  // Expose seeding for tests via a hidden handle.
  ;(adapter as unknown as {
    __seed: typeof seedBalance
    __seedSimulation: typeof seedSimulation
    __seedBroadcastBehavior: typeof seedBroadcastBehavior
  }).__seed = seedBalance
  ;(adapter as unknown as {
    __seedSimulation: typeof seedSimulation
  }).__seedSimulation = seedSimulation
  ;(adapter as unknown as {
    __seedBroadcastBehavior: typeof seedBroadcastBehavior
  }).__seedBroadcastBehavior = seedBroadcastBehavior

  return adapter
}

/**
 * Build a Ref-carrying mock adapter — useful when tests need to reach
 * in and pre-seed balances. Returns both the adapter and its state.
 */
export const makeMockChainAdapterWithState = (config: ChainConfig) => {
  const adapter = makeMockChainAdapter(config)
  const seedBalance = (address: string, asset: AssetId, amount: bigint) => {
    ;(adapter as unknown as {
      __seed: (a: string, b: AssetId, c: bigint) => void
    }).__seed(address, asset, amount)
  }
  return { adapter, seedBalance }
}
