import {
  AccountAddress,
  ChainId,
  EntryFunction,
  RawTransaction,
  TransactionPayloadEntryFunction,
  MoveVector,
  U8,
} from "@aptos-labs/ts-sdk"

/**
 * Build a valid BCS-encoded Aptos `RawTransaction` in memory — no
 * network calls. Used in tests to prove the adapter's framing parser
 * can round-trip through `RawTransaction.deserialize`.
 */
export const buildRealRawTx = (fromAddressHex: string): Uint8Array => {
  const sender = AccountAddress.fromString(fromAddressHex)
  const entry = EntryFunction.build(
    "0x1::aptos_account",
    "transfer_coins",
    [],
    // Arg shape doesn't matter; BCS just needs to round-trip. Keep it
    // minimal — one empty Move vector of u8.
    [new MoveVector<U8>([new U8(0)])],
  )
  const payload = new TransactionPayloadEntryFunction(entry)
  const raw = new RawTransaction(
    sender,
    0n,
    payload,
    200_000n,
    100n,
    BigInt(Math.floor(Date.now() / 1000) + 600),
    new ChainId(1),
  )
  return raw.bcsToBytes()
}
