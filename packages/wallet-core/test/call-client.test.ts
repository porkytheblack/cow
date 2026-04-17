import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { createWalletClient } from "../src/client.js"
import { makeMockFetchAdapter } from "../src/adapters/fetch/mock.js"
import { makeMockChainAdapter } from "../src/adapters/chain/mock.js"
import { makeChainAdapterRegistryLayer } from "../src/adapters/chain/registry.js"
import type { ChainAdapter } from "../src/adapters/chain/index.js"
import type { ChainId } from "../src/model/chain.js"
import type { CallSimulation } from "../src/model/call.js"
import {
  AuthGateService,
  withSessionSupport,
} from "../src/services/auth-gate.js"
import type { AuthApproval, AuthRequest } from "../src/model/auth.js"
import { testConfig } from "./helpers/test-config.js"

const makeCountingAuthGate = () => {
  const state = { requestCount: 0, lastReason: "" }
  const layer = Layer.effect(
    AuthGateService,
    withSessionSupport(
      {
        requestApproval: (request: AuthRequest) => {
          state.requestCount += 1
          state.lastReason = request.reason
          return Effect.succeed<AuthApproval>({
            method:
              request.requiredLevel === "elevated" ? "passkey" : "pin",
            timestamp: Date.now(),
            sessionToken: "test-session",
          })
        },
        registerPasskey: () => Effect.void,
        registerPin: () => Effect.void,
        deriveEncryptionKey: () =>
          Effect.succeed(new Uint8Array(32).fill(0x42)),
        beginSession: () =>
          Effect.succeed<AuthApproval>({
            method: "pin",
            timestamp: Date.now(),
            sessionToken: "test-session",
          }),
        endSession: () => Effect.void,
        hasActiveSession: () => Effect.succeed(false),
      },
      60_000,
    ),
  )
  return { layer, state }
}

const makeClient = () => {
  const adapters = new Map<ChainId, ChainAdapter>()
  for (const chain of testConfig.chains) {
    adapters.set(chain.chainId, makeMockChainAdapter(chain))
  }
  const seedSimulation = (chain: ChainId, sim: CallSimulation) => {
    const adapter = adapters.get(chain)!
    ;(adapter as unknown as {
      __seedSimulation: (s: CallSimulation) => void
    }).__seedSimulation(sim)
  }
  const mockFetch = makeMockFetchAdapter({
    handlers: [],
    fallbackTo404: true,
  })
  const auth = makeCountingAuthGate()
  const client = createWalletClient(testConfig, {
    chainRegistry: makeChainAdapterRegistryLayer(adapters),
    fetch: mockFetch,
    authGate: auth.layer,
  })
  return { client, auth: auth.state, seedSimulation }
}

describe("WalletClient arbitrary call API", () => {
  it("buildCall returns an UnsignedTx carrying the caller label as intent", async () => {
    const { client } = makeClient()
    const { keys } = await client.generate()
    const evm = keys.find((k) => k.chain === "evm:1")!
    const tx = await client.buildCall({
      kind: "evm",
      chain: "evm:1",
      from: evm.address,
      to: "0x0000000000000000000000000000000000000042",
      data: "0xdeadbeef",
      label: "call X",
    })
    expect(tx.chain).toBe("evm:1")
    expect(tx.metadata.intent).toBe("call X")
    expect(tx.from).toBe(evm.address)
  })

  it("sendCall triggers exactly one auth-gate prompt and returns a confirmed receipt", async () => {
    const { client, auth } = makeClient()
    const { keys } = await client.generate()
    const evm = keys.find((k) => k.chain === "evm:1")!
    const receipt = await client.sendCall({
      kind: "evm",
      chain: "evm:1",
      from: evm.address,
      to: "0x0000000000000000000000000000000000000042",
      data: "0xdeadbeef",
      label: "Call 42",
    })
    expect(receipt.status).toBe("confirmed")
    expect(receipt.chain).toBe("evm:1")
    expect(auth.requestCount).toBe(1)
    expect(auth.lastReason).toBe("Call 42")
  })

  it("approveSession covers multiple sendCall invocations with one prompt", async () => {
    const { client, auth } = makeClient()
    const { keys } = await client.generate()
    const evm = keys.find((k) => k.chain === "evm:1")!

    await client.approveSession("batch")
    await client.sendCall({
      kind: "evm",
      chain: "evm:1",
      from: evm.address,
      to: "0x01",
      data: "0x01",
    })
    await client.sendCall({
      kind: "evm",
      chain: "evm:1",
      from: evm.address,
      to: "0x02",
      data: "0x02",
    })
    await client.sendCall({
      kind: "evm",
      chain: "evm:1",
      from: evm.address,
      to: "0x03",
      data: "0x03",
    })
    // Session covers the three sendCalls. `approveSession` itself
    // internally calls `requestApproval` once to seed the session —
    // that's the only prompt the user sees.
    expect(auth.requestCount).toBe(1)
  })

  it("simulateCall returns the mock adapter's seeded response", async () => {
    const { client, seedSimulation } = makeClient()
    const { keys } = await client.generate()
    const evm = keys.find((k) => k.chain === "evm:1")!

    seedSimulation("evm:1", {
      success: false,
      revertReason: "seeded revert",
    })

    const sim = await client.simulateCall({
      kind: "evm",
      chain: "evm:1",
      from: evm.address,
      to: "0x0000000000000000000000000000000000000042",
      data: "0x",
    })
    expect(sim.success).toBe(false)
    expect(sim.revertReason).toBe("seeded revert")
  })
})
