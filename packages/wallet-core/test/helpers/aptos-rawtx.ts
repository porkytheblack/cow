import {
  AccountAddress,
  ChainId,
  EntryFunction,
  MoveVector,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  U8,
} from "@aptos-labs/ts-sdk"

/**
 * Build a `SimpleTransaction` in memory (no network) whose BCS bytes can
 * round-trip through `SimpleTransaction.deserialize` — matches what the
 * adapter now serialises with `txn.bcsToBytes()`. Optionally stamps
 * `feePayerAddress = 0x0` so sponsored-path tests look like the real
 * gas-station wildcard.
 */
export const buildRealSimpleTx = (
  fromAddressHex: string,
  opts: { sponsored?: boolean } = {},
): { simpleBcs: Uint8Array; rawBcs: Uint8Array } => {
  const sender = AccountAddress.fromString(fromAddressHex)
  const entry = EntryFunction.build(
    "0x1::aptos_account",
    "transfer_coins",
    [],
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
  const simple = new SimpleTransaction(
    raw,
    opts.sponsored ? AccountAddress.ZERO : undefined,
  )
  return { rawBcs: raw.bcsToBytes(), simpleBcs: simple.bcsToBytes() }
}
