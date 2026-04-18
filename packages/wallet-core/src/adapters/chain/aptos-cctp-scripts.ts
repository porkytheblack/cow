import type { AptosCctpV1Contracts } from "./aptos.js"

/**
 * Bundled Circle CCTP V1 Move scripts for Aptos. Mainnet and testnet
 * bytecode are NOT interchangeable — each embeds the Circle package
 * address for its network.
 *
 * Source: https://github.com/circlefin/aptos-cctp/tree/master/typescript/example/precompiled-move-scripts
 *
 * SHA-256 of the source `.mv` files (verify if bumping):
 *   mainnet deposit_for_burn             a1118b4357d55a3c638576f6c47d6859e1e31f93f4b881127ecdf4e0c1a0c5ac
 *   mainnet deposit_for_burn_with_caller 062ff38aeac7d24df3c4ab1056194f521019fdc80317f282b8f0f86b3e0818e4
 *   mainnet handle_receive_message       c0da30dbacdc03903a0c8cee125df895b0c66d9c0eae6ad97c1038f09c50375b
 *   testnet deposit_for_burn             803588c717910794c57763beb009ec0cb4ec62e186dcae7bdcc85669641d47e8
 *   testnet deposit_for_burn_with_caller 8d023601439146f48bc9a0003381787da56fa4be23a25b7550fb153ac5d7b780
 *   testnet handle_receive_message       41658fda33c01bb0aa4b81f6197e41732f54e346a16d69eeefb953961a8e7c66
 */

// --- Base64-encoded .mv payloads ----------------------------------------

const MAINNET_DEPOSIT_FOR_BURN_B64 =
  "oRzrCwcAAAoHAQAIAggOAxYUBCoEBS4wB16HAQjlAUAAAAABAAIBAwAEAAABBQcBAAEABgsAAQcDBAEIAQIIBQYBCAEDCQgJAAEAAgECBQYMAw4FBQIIAAsBAQgCAQgCAQUBCwEBCQADBgwLAQEJAAMBCAAABAYMCAAOBQEDDmZ1bmdpYmxlX2Fzc2V0Bm9iamVjdBZwcmltYXJ5X2Z1bmdpYmxlX3N0b3JlD3Rva2VuX21lc3Nlbmdlcg1GdW5naWJsZUFzc2V0Bk9iamVjdAhNZXRhZGF0YRFhZGRyZXNzX3RvX29iamVjdAh3aXRoZHJhdxBkZXBvc2l0X2Zvcl9idXJuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGbzmc097Y+g1EI472MNnQ9Rwn+Q19EeRkYgB0JiWQKnQAAAQ8LBDgADAYKAAsGCwE4AQwFCwALBQsCCwMRAgEC"

const MAINNET_DEPOSIT_FOR_BURN_WITH_CALLER_B64 =
  "oRzrCwcAAAoHAQAIAggOAxYUBCoEBS4yB2CTAQjzAUAAAAABAAIBAwAEAAABBQcBAAEABgsAAQcDBAEIAQIIBQYBCAEDCQgJAAEAAgECBgYMAw4FBQUCCAALAQEIAgEIAgEFAQsBAQkAAwYMCwEBCQADAQgAAAUGDAgADgUFAQMOZnVuZ2libGVfYXNzZXQGb2JqZWN0FnByaW1hcnlfZnVuZ2libGVfc3RvcmUPdG9rZW5fbWVzc2VuZ2VyDUZ1bmdpYmxlQXNzZXQGT2JqZWN0CE1ldGFkYXRhEWFkZHJlc3NfdG9fb2JqZWN0CHdpdGhkcmF3HGRlcG9zaXRfZm9yX2J1cm5fd2l0aF9jYWxsZXIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZvOZzT3tj6DUQjjvYw2dD1HCf5DX0R5GRiAHQmJZAqdAAABEAsEOAAMBwoACwcLATgBDAYLAAsGCwILAwsFEQIBAg=="

const MAINNET_HANDLE_RECEIVE_MESSAGE_B64 =
  "oRzrCwcAAAoGAQAEAgQEAwgMBRQWBypTCH1AAAABAQACAAAAAwIDAAEBBAMEAAEDBgwKAgoCAAMGDAYKAgYKAgEIAAEBE21lc3NhZ2VfdHJhbnNtaXR0ZXIPdG9rZW5fbWVzc2VuZ2VyB1JlY2VpcHQPcmVjZWl2ZV9tZXNzYWdlFmhhbmRsZV9yZWNlaXZlX21lc3NhZ2UXfhd1GCDktDcYc8qMMCeb5jvepjuI7Q8iOcLuoQ8XcpvOZzT3tj6DUQjjvYw2dD1HCf5DX0R5GRiAHQmJZAqdAAABBwsADgEOAhEAEQEBAg=="

const TESTNET_DEPOSIT_FOR_BURN_B64 =
  "oRzrCwcAAAoHAQAIAggOAxYUBCoEBS4wB16HAQjlAUAAAAABAAIBAwAEAAABBQcBAAEABgsAAQcDBAEIAQIIBQYBCAEDCQgJAAEAAgECBQYMAw4FBQIIAAsBAQgCAQgCAQUBCwEBCQADBgwLAQEJAAMBCAAABAYMCAAOBQEDDmZ1bmdpYmxlX2Fzc2V0Bm9iamVjdBZwcmltYXJ5X2Z1bmdpYmxlX3N0b3JlD3Rva2VuX21lc3Nlbmdlcg1GdW5naWJsZUFzc2V0Bk9iamVjdAhNZXRhZGF0YRFhZGRyZXNzX3RvX29iamVjdAh3aXRoZHJhdxBkZXBvc2l0X2Zvcl9idXJuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFfm5N0Gd2pCqBsGDa3hH9lu74/EhdWd1jcJIi+MaR3uQAAAQ8LBDgADAYKAAsGCwE4AQwFCwALBQsCCwMRAgEC"

const TESTNET_DEPOSIT_FOR_BURN_WITH_CALLER_B64 =
  "oRzrCwcAAAoHAQAIAggOAxYUBCoEBS4yB2CTAQjzAUAAAAABAAIBAwAEAAABBQcBAAEABgsAAQcDBAEIAQIIBQYBCAEDCQgJAAEAAgECBgYMAw4FBQUCCAALAQEIAgEIAgEFAQsBAQkAAwYMCwEBCQADAQgAAAUGDAgADgUFAQMOZnVuZ2libGVfYXNzZXQGb2JqZWN0FnByaW1hcnlfZnVuZ2libGVfc3RvcmUPdG9rZW5fbWVzc2VuZ2VyDUZ1bmdpYmxlQXNzZXQGT2JqZWN0CE1ldGFkYXRhEWFkZHJlc3NfdG9fb2JqZWN0CHdpdGhkcmF3HGRlcG9zaXRfZm9yX2J1cm5fd2l0aF9jYWxsZXIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAV+bk3QZ3akKoGwYNreEf2W7vj8SF1Z3WNwkiL4xpHe5AAABEAsEOAAMBwoACwcLATgBDAYLAAsGCwILAwsFEQIBAg=="

const TESTNET_HANDLE_RECEIVE_MESSAGE_B64 =
  "oRzrCwcAAAoGAQAEAgQEAwgMBRQWBypTCH1AAAABAQACAAAAAwIDAAEBBAMEAAEDBgwKAgoCAAMGDAYKAgYKAgEIAAEBE21lc3NhZ2VfdHJhbnNtaXR0ZXIPdG9rZW5fbWVzc2VuZ2VyB1JlY2VpcHQPcmVjZWl2ZV9tZXNzYWdlFmhhbmRsZV9yZWNlaXZlX21lc3NhZ2UIHobOv0V6DGAE81vWSKJ5Rpj1Lg3eCaSGGdzT1Mwj2V+bk3QZ3akKoGwYNreEf2W7vj8SF1Z3WNwkiL4xpHe5AAABBwsADgEOAhEAEQEBAg=="

// Works in both Node 16+ and modern browsers — `atob` is globalThis on both.
const decodeBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Decoded once at module load. Adapters hold these Uint8Array references
// directly — they never mutate them.
const MAINNET_DEPOSIT_FOR_BURN = decodeBase64(MAINNET_DEPOSIT_FOR_BURN_B64)
const MAINNET_DEPOSIT_FOR_BURN_WITH_CALLER = decodeBase64(
  MAINNET_DEPOSIT_FOR_BURN_WITH_CALLER_B64,
)
const MAINNET_HANDLE_RECEIVE_MESSAGE = decodeBase64(
  MAINNET_HANDLE_RECEIVE_MESSAGE_B64,
)
const TESTNET_DEPOSIT_FOR_BURN = decodeBase64(TESTNET_DEPOSIT_FOR_BURN_B64)
const TESTNET_DEPOSIT_FOR_BURN_WITH_CALLER = decodeBase64(
  TESTNET_DEPOSIT_FOR_BURN_WITH_CALLER_B64,
)
const TESTNET_HANDLE_RECEIVE_MESSAGE = decodeBase64(
  TESTNET_HANDLE_RECEIVE_MESSAGE_B64,
)

// --- Well-known USDC fungible-asset metadata addresses ------------------

/** Aptos mainnet USDC metadata object (the on-chain `FA::Metadata` ref). */
export const APTOS_USDC_METADATA_MAINNET =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b"

/** Aptos testnet USDC metadata object. */
export const APTOS_USDC_METADATA_TESTNET =
  "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832"

// --- Public bundles consumers wire into the adapter ---------------------

/**
 * Canonical Circle CCTP V1 wiring for Aptos **mainnet**. Pass this as
 * `cctpContracts` when constructing `makeAptosChainAdapter`, or rely on
 * `makeAptosAwareRegistryLive`'s built-in fallback which uses this map
 * when no per-chain `cctpContractMap` entry is supplied.
 */
export const APTOS_CCTP_V1_MAINNET: AptosCctpV1Contracts = {
  usdcTokenAddress: APTOS_USDC_METADATA_MAINNET,
  depositForBurnScript: MAINNET_DEPOSIT_FOR_BURN,
  depositForBurnWithCallerScript: MAINNET_DEPOSIT_FOR_BURN_WITH_CALLER,
  handleReceiveMessageScript: MAINNET_HANDLE_RECEIVE_MESSAGE,
  version: "v1",
}

/** Canonical Circle CCTP V1 wiring for Aptos **testnet**. */
export const APTOS_CCTP_V1_TESTNET: AptosCctpV1Contracts = {
  usdcTokenAddress: APTOS_USDC_METADATA_TESTNET,
  depositForBurnScript: TESTNET_DEPOSIT_FOR_BURN,
  depositForBurnWithCallerScript: TESTNET_DEPOSIT_FOR_BURN_WITH_CALLER,
  handleReceiveMessageScript: TESTNET_HANDLE_RECEIVE_MESSAGE,
  version: "v1",
}
