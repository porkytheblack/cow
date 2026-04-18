import { Context, Effect, Layer } from "effect"
import type { ChainConfig, ChainId } from "../model/chain.js"
import { UnsupportedChainError } from "../model/errors.js"
import {
  DEFAULT_CCTP_POLL_INTERVAL_MS,
  DEFAULT_CCTP_TIMEOUT_MS,
  DEFAULT_DERIVATION_PATHS,
} from "./defaults.js"

export interface CctpContractAddresses {
  /**
   * Source-burn program/module/contract address.
   *   - EVM: `TokenMessenger` 20-byte hex address.
   *   - Solana: `TokenMessengerMinter` base58 program ID.
   *   - Aptos: the Circle CCTP package address (the `@token_messenger_minter`
   *     named address resolved to its on-chain object) — same value as
   *     `messageTransmitter`.
   */
  readonly tokenMessenger: string
  /**
   * Destination-mint program/module/contract.
   *   - EVM: `MessageTransmitter` 20-byte hex address.
   *   - Solana: `MessageTransmitter` base58 program ID.
   *   - Aptos: the Circle CCTP package address (the `@message_transmitter`
   *     named address).
   */
  readonly messageTransmitter: string
  /**
   * The on-chain USDC token reference:
   *   - EVM: USDC ERC20 20-byte hex address.
   *   - Solana: USDC SPL mint base58 pubkey.
   *   - Aptos: USDC fungible-asset metadata object (`0xbae2...6f3b` on mainnet).
   */
  readonly usdcToken: string
  readonly version?: "v1" | "v2"
  /**
   * Aptos-only: the CCTP burn/mint functions are `public fun`s that
   * take/return non-copyable `FungibleAsset` / `Receipt` types, so they
   * cannot be called as a plain entry function. Circle ships compiled
   * Move **scripts** that compose the primitives end-to-end. The wallet
   * submits these as `TransactionPayloadScript` payloads with typed args.
   *
   * Consumers supply the compiled bytecode (e.g. loaded from
   * `aptos-cctp/packages/token_messenger_minter/scripts/deposit_for_burn.mv`).
   * Both scripts are required to burn + mint on Aptos; without them the
   * adapter returns `UnsupportedRouteError`.
   */
  readonly aptosScriptBytecode?: {
    readonly depositForBurn?: Uint8Array
    readonly depositForBurnWithCaller?: Uint8Array
    readonly handleReceiveMessage?: Uint8Array
  }
}

export interface CctpConfig {
  readonly attestationApiUrl: string
  readonly contractAddresses: Partial<Record<ChainId, CctpContractAddresses>>
  readonly attestationPollIntervalMs: number
  readonly attestationTimeoutMs: number
}

export interface AuthConfig {
  /**
   * Transactions whose `estimatedFee` is at or above this threshold
   * trigger passkey-grade ("elevated") approval. Measured in the chain's
   * native fee unit (wei, lamports, octas).
   */
  readonly elevatedThreshold: bigint
  readonly sessionTtlMs: number
  readonly pinMinLength: number
}

export interface KeyringConfig {
  readonly mnemonicStrength: 128 | 256
  readonly derivationPaths: Partial<Record<ChainId, string>>
}

/**
 * Full resolved config — every field is present after `resolveConfig`.
 * This is what services consume internally.
 */
export interface WalletConfig {
  readonly chains: readonly ChainConfig[]
  readonly cctp: CctpConfig
  readonly auth: AuthConfig
  readonly keyring: KeyringConfig
  readonly [key: string]: unknown
}

/**
 * User-facing config — `cctp`, `auth`, and `keyring` are optional and
 * get filled with sensible defaults by `resolveConfig`. This makes the
 * simple "I just want an EVM wallet" case 3-5 lines:
 *
 * ```ts
 * createWalletClient({
 *   chains: [{ chainId: "evm:1", kind: "evm", name: "Ethereum", rpcUrl: "https://...", nativeAsset: { ... } }],
 * })
 * ```
 */
export interface WalletConfigInput {
  readonly chains: readonly ChainConfig[]
  readonly cctp?: Partial<CctpConfig>
  readonly auth?: Partial<AuthConfig>
  readonly keyring?: Partial<KeyringConfig>
  readonly [key: string]: unknown
}

const DEFAULT_AUTH: AuthConfig = {
  elevatedThreshold: 100_000_000n,
  sessionTtlMs: 300_000,
  pinMinLength: 4,
}

const DEFAULT_CCTP: CctpConfig = {
  // Iris root — `pollCircleAttestation` appends `/v1` or `/v2` per burn.
  attestationApiUrl: "https://iris-api.circle.com",
  contractAddresses: {},
  attestationPollIntervalMs: DEFAULT_CCTP_POLL_INTERVAL_MS,
  attestationTimeoutMs: DEFAULT_CCTP_TIMEOUT_MS,
}

/**
 * Merge user-supplied partial config with sensible defaults. Builds
 * `keyring.derivationPaths` from `DEFAULT_DERIVATION_PATHS` for any
 * chain that doesn't have an explicit path.
 */
export const resolveConfig = (input: WalletConfigInput): WalletConfig => {
  const mergedPaths: Partial<Record<string, string>> = {
    ...DEFAULT_DERIVATION_PATHS,
    ...input.keyring?.derivationPaths,
  }
  const configuredChainIds = new Set(input.chains.map((c) => c.chainId))
  const filteredPaths: Record<string, string> = {}
  for (const [k, v] of Object.entries(mergedPaths)) {
    if (v !== undefined && configuredChainIds.has(k)) filteredPaths[k] = v
  }
  return {
    ...input,
    chains: input.chains,
    cctp: {
      ...DEFAULT_CCTP,
      ...input.cctp,
      contractAddresses: {
        ...DEFAULT_CCTP.contractAddresses,
        ...input.cctp?.contractAddresses,
      },
    },
    auth: { ...DEFAULT_AUTH, ...input.auth },
    keyring: {
      mnemonicStrength: input.keyring?.mnemonicStrength ?? 128,
      derivationPaths: filteredPaths,
    },
  }
}

export interface WalletConfigServiceShape {
  readonly config: WalletConfig
  readonly getChain: (
    chainId: ChainId,
  ) => Effect.Effect<ChainConfig, UnsupportedChainError>
  readonly listChains: () => readonly ChainConfig[]
}

export class WalletConfigService extends Context.Tag("WalletConfigService")<
  WalletConfigService,
  WalletConfigServiceShape
>() {}

/**
 * Build a WalletConfigService Layer from a static WalletConfig object.
 */
export const makeWalletConfigLayer = (
  config: WalletConfig,
): Layer.Layer<WalletConfigService> =>
  Layer.succeed(WalletConfigService, {
    config,
    getChain: (chainId) => {
      const found = config.chains.find((c) => c.chainId === chainId)
      return found
        ? Effect.succeed(found)
        : Effect.fail(new UnsupportedChainError({ chain: String(chainId) }))
    },
    listChains: () => config.chains,
  })
