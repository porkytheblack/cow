import { Context, Effect, Layer } from "effect"
import type { ChainConfig, ChainId } from "../model/chain.js"
import { UnsupportedChainError } from "../model/errors.js"

export interface CctpConfig {
  readonly attestationApiUrl: string
  readonly contractAddresses: Partial<
    Record<
      ChainId,
      {
        readonly tokenMessenger: string
        readonly messageTransmitter: string
        readonly usdcToken: string
      }
    >
  >
  readonly attestationPollIntervalMs: number
  readonly attestationTimeoutMs: number
}

export interface AuthConfig {
  readonly elevatedThreshold: bigint
  readonly sessionTtlMs: number
  readonly pinMinLength: number
}

export interface KeyringConfig {
  readonly mnemonicStrength: 128 | 256
  readonly derivationPaths: Partial<Record<ChainId, string>>
}

export interface WalletConfig {
  readonly chains: readonly ChainConfig[]
  readonly cctp: CctpConfig
  readonly auth: AuthConfig
  readonly keyring: KeyringConfig
  /** Open-ended extension — consumers can thread custom keys. */
  readonly [key: string]: unknown
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
