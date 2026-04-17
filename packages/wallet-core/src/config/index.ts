import { Context, Effect, Layer } from "effect"
import type { ChainConfig, ChainId } from "../model/chain.js"
import { UnsupportedChainError } from "../model/errors.js"
import {
  DEFAULT_CCTP_POLL_INTERVAL_MS,
  DEFAULT_CCTP_TIMEOUT_MS,
  DEFAULT_DERIVATION_PATHS,
} from "./defaults.js"

export interface CctpContractAddresses {
  readonly tokenMessenger: string
  readonly messageTransmitter: string
  readonly usdcToken: string
  readonly version?: "v1" | "v2"
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
  attestationApiUrl: "https://iris-api.circle.com/v2",
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
