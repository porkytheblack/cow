import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    config: "src/config/index.ts",
    test: "test/helpers/test-layers.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
  treeshake: true,
  external: [
    "effect",
    "@aptos-labs/ts-sdk",
    "@noble/ciphers",
    "@noble/curves",
    "@noble/hashes",
    "@scure/bip32",
    "@scure/bip39",
    "@solana/web3.js",
    "viem",
  ],
})
