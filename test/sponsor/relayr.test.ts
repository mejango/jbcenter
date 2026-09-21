import { afterEach, describe, expect, test, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getContractCatalog } from "../../src/rest/contracts/catalog.js";
import type { SponsorshipChain } from "../../src/rest/sponsorship/chain.js";
import {
  FORWARD_REQUEST_TYPES,
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
} from "../../src/rest/sponsorship/constants.js";
import { RELAYR_PAYMENT_EVENT } from "../../src/rest/sponsorship/paymentContract.js";
import type { RelayrProvider } from "../../src/rest/sponsorship/provider.js";
import type { PreparedForwardRequest, RelayrEntry } from "../../src/rest/sponsorship/types.js";
import type { RestCall } from "../../src/rest/core.js";
import { CREATE_TOPIC, PROJECTS_ABI, type LaneReport } from "../../src/sponsor/chain.js";
import { readSponsorPolicy, reservationWei } from "../../src/sponsor/policy.js";
import { createRelayrLane } from "../../src/sponsor/relayr.js";
import type { Intent } from "../../src/types.js";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PROJECTS = "0x2222222222222222222222222222222222222222" as Address;
const FORWARDER = "0x3333333333333333333333333333333333333333" as Address;
const TARGET = "0x4444444444444444444444444444444444444444" as Address;
const BUNDLE = "a0a555ff-4444-4111-aaaa-333333333333";
const TX_UUIDS = [
  "b0a555ff-4444-4111-aaaa-333333333333",
  "c0a555ff-4444-4111-aaaa-333333333333",
];
const NOW = 1_700_000_000_000;
const PAYMENT_DEADLINE = BigInt(NOW / 1000 + 3600);
const PAYMENT_AMOUNT = 1_000_000_000_000_000n;
const CREATION_FEE = 100_000_000_000_000n;
const BLOCK = 4_000_000n;
const BLOCK_HASH = `0x${"55".repeat(32)}` as Hex;
const GAS_USED = 21_000n;
const GAS_PRICE = 2_000_000_000n;
const PAYMENT_HASH = `0x${"ee".repeat(32)}` as Hex;
const policy = readSponsorPolicy({});
const catalog = await getContractCatalog();

const rpcUrl = (chainId: number) => `https://rpc.test/${chainId}`;
const deployHash = (chainId: number) =>
  `0x${chainId.toString(16).padStart(8, "0")}${"77".repeat(28)}` as Hex;

function intent(chainIds: number[]): Intent {
  return {
    id: "intent-1",
    status: "undeployed",
    contentHash: `0x${"aa".repeat(32)}`,
    name: "Public goods garden",
    description: null,
    tagline: null,
    tags: [],
    logoUri: null,
    owner: null,
    publisher: signer.address,
    signature: `0x${"bb".repeat(65)}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    deployments: [],
    deploys: [],
    envelope: {
      format: "juicebox.money/v1",
      deploymentVersion: "6",
      chainIds,
      deploymentCalls: chainIds.map((chainId, index) => ({
        chainId,
        to: TARGET,
        data: `0x1234567${index}` as Hex,
      })),
      jb: { name: "Public goods garden" },
    },
  };
}

function fakeChain() {
  const prepare = vi.fn(
    async (
      _catalog: unknown,
      call: RestCall,
      account: Address,
      stepIndex: number,
      deadline: number,
    ): Promise<PreparedForwardRequest> => ({
      stepIndex,
      chainId: call.chainId,
      forwarder: FORWARDER,
      forwarderCodeHash: `0x${"11".repeat(32)}`,
      targetCodeHash: `0x${"22".repeat(32)}`,
      domain: { name: "Juicebox", version: "1", chainId: call.chainId, verifyingContract: FORWARDER },
      message: {
        from: account,
        to: call.to,
        value: call.value,
        gas: "300000",
        nonce: String(stepIndex),
        deadline: String(deadline),
        data: call.data,
      },
      evidence: {
        chainId: call.chainId,
        blockNumber: BLOCK.toString(),
        blockHash: BLOCK_HASH,
        timestamp: String(NOW / 1000),
        source: "onchain",
      },
    }),
  );
  const signed = vi.fn(
    async (
      request: PreparedForwardRequest,
      signature: Hex,
      preceding: RelayrEntry[] = [],
    ): Promise<RelayrEntry> => {
      const recovered = await recoverTypedDataAddress({
        domain: request.domain,
        types: FORWARD_REQUEST_TYPES,
        primaryType: "ForwardRequest",
        message: {
          from: request.message.from,
          to: request.message.to,
          value: BigInt(request.message.value),
          gas: BigInt(request.message.gas),
          nonce: BigInt(request.message.nonce),
          deadline: Number(request.message.deadline),
          data: request.message.data,
        },
        signature,
      });
      if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error("the forward request was not signed by the sponsor key");
      }
      return {
        chain: request.chainId,
        target: request.forwarder,
        data: `0x47153f82${request.message.data.slice(2)}`,
        value: request.message.value,
        virtual_nonce: preceding.length,
      };
    },
  );
  return { prepare, signed, chain: { prepare, signed } as unknown as SponsorshipChain };
}

function paymentCalldata(): Hex {
  const args = encodeAbiParameters(
    [{ type: "bytes16" }, { type: "uint256" }],
    [`0x${BUNDLE.replaceAll("-", "")}`, PAYMENT_DEADLINE],
  );
  return `0x103903a7${args.slice(2)}`;
}

function fakeProvider(options: {
  chainIds: number[];
  paymentChainId: number;
  hashAfter: number;
  hashes: Map<number, Hex>;
  amount: bigint;
}) {
  let submitted: RelayrEntry[] = options.chainIds.map((chain) => ({
    chain,
    target: FORWARDER,
    data: "0x",
    value: "0",
    virtual_nonce: 0,
  }));
  let polls = 0;
  const create = vi.fn(async (entries: RelayrEntry[]) => {
    submitted = entries;
    return {
      bundle_uuid: BUNDLE,
      tx_uuids: TX_UUIDS.slice(0, entries.length),
      payment_info: [
        {
          chain: options.paymentChainId,
          target: RELAYR_PAYMENT_ADDRESS,
          token: RELAYR_NATIVE_TOKEN,
          amount: options.amount.toString(),
          calldata: paymentCalldata(),
          payment_deadline: PAYMENT_DEADLINE.toString(),
        },
      ],
    };
  });
  const status = vi.fn(async () => {
    polls += 1;
    const ready = polls >= options.hashAfter;
    return {
      bundle_uuid: BUNDLE,
      transactions: submitted.map((entry, index) => ({
        tx_uuid: TX_UUIDS[index]!,
        request: { ...entry },
        status: ready
          ? { state: "Included", data: { hash: options.hashes.get(entry.chain) } }
          : { state: "Pending", data: {} },
      })),
    };
  });
  return {
    create,
    status,
    provider: { create, status } as unknown as RelayrProvider,
    polls: () => polls,
  };
}

function receiptLog(address: Address, topics: Hex[], data: Hex, transactionHash: Hex, index: number) {
  return {
    address,
    topics,
    data,
    blockHash: BLOCK_HASH,
    blockNumber: toHex(BLOCK - 1n),
    logIndex: toHex(index),
    transactionHash,
    transactionIndex: "0x0",
    removed: false,
  };
}

function receipt(transactionHash: Hex, to: Address, logs: unknown[], status: "0x1" | "0x0" = "0x1") {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: toHex(BLOCK - 1n),
    contractAddress: null,
    cumulativeGasUsed: toHex(GAS_USED),
    effectiveGasPrice: toHex(GAS_PRICE),
    from: signer.address,
    gasUsed: toHex(GAS_USED),
    logs,
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    to,
    transactionHash,
    transactionIndex: "0x0",
    type: "0x2",
  };
}

function paymentReceipt(amount: bigint, reverted = false) {
  if (reverted) return receipt(PAYMENT_HASH, RELAYR_PAYMENT_ADDRESS as Address, [], "0x0");
  const data =
    `0x${amount.toString(16).padStart(64, "0")}${PAYMENT_DEADLINE.toString(16).padStart(64, "0")}` as Hex;
  return receipt(
    PAYMENT_HASH,
    RELAYR_PAYMENT_ADDRESS as Address,
    [
      receiptLog(
        RELAYR_PAYMENT_ADDRESS as Address,
        [RELAYR_PAYMENT_EVENT, `0x${BUNDLE.replaceAll("-", "").padEnd(64, "0")}`],
        data,
        PAYMENT_HASH,
        0,
      ),
    ],
  );
}

function deployReceipt(transactionHash: Hex, projectId: string, reverted = false) {
  if (reverted) return receipt(transactionHash, FORWARDER, [], "0x0");
  return receipt(transactionHash, FORWARDER, [
    receiptLog(
      PROJECTS,
      [CREATE_TOPIC, toHex(BigInt(projectId), { size: 32 }), pad(signer.address, { size: 32 })],
      "0x",
      transactionHash,
      0,
    ),
  ]);
}

function block() {
  return {
    baseFeePerGas: toHex(1_000_000_000n),
    difficulty: "0x0",
    extraData: "0x",
    gasLimit: toHex(30_000_000n),
    gasUsed: "0x0",
    hash: BLOCK_HASH,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: `0x${"00".repeat(20)}`,
    mixHash: `0x${"00".repeat(32)}`,
    nonce: "0x0000000000000000",
    number: toHex(BLOCK),
    parentHash: `0x${"66".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    size: "0x0",
    stateRoot: `0x${"00".repeat(32)}`,
    timestamp: toHex(BigInt(NOW / 1000)),
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: `0x${"00".repeat(32)}`,
    uncles: [],
  };
}

function installRpc(receipts: Map<string, unknown>, events: string[]) {
  const prepayments: TransactionSerializedEIP1559[] = [];
  const feeCall = encodeFunctionData({ abi: PROJECTS_ABI, functionName: "creationFee" });
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const result = ((): unknown => {
      switch (method) {
        case "eth_call": {
          const call = params[0] as { to: Address; data: Hex };
          if (call.to !== PROJECTS || call.data !== feeCall) {
            throw new Error(`unexpected eth_call to ${call.to}`);
          }
          return toHex(CREATION_FEE, { size: 32 });
        }
        case "eth_blockNumber":
          return toHex(BLOCK);
        case "eth_getBlockByNumber":
          return block();
        case "eth_maxPriorityFeePerGas":
          return toHex(1_000_000n);
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_sendRawTransaction":
          events.push("prepayment");
          prepayments.push(params[0] as TransactionSerializedEIP1559);
          return PAYMENT_HASH;
        case "eth_getTransactionReceipt":
          return receipts.get(String(params[0]).toLowerCase()) ?? null;
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return prepayments;
}

function harness(options: {
  chainIds: number[];
  paymentChainId: number;
  hashAfter: number;
  projectIds: string[];
  amount?: bigint;
  revertedChains?: number[];
  revertedPayment?: boolean;
}) {
  const amount = options.amount ?? PAYMENT_AMOUNT;
  const hashes = new Map(options.chainIds.map((chainId) => [chainId, deployHash(chainId)]));
  const receipts = new Map<string, unknown>([
    [PAYMENT_HASH, paymentReceipt(amount, options.revertedPayment)],
  ]);
  options.chainIds.forEach((chainId, index) =>
    receipts.set(
      hashes.get(chainId)!,
      deployReceipt(
        hashes.get(chainId)!,
        options.projectIds[index]!,
        options.revertedChains?.includes(chainId),
      ),
    ),
  );
  const events: string[] = [];
  const prepayments = installRpc(receipts, events);
  const chain = fakeChain();
  const provider = fakeProvider({
    chainIds: options.chainIds,
    paymentChainId: options.paymentChainId,
    hashAfter: options.hashAfter,
    hashes,
    amount,
  });
  const report = {
    bundle: vi.fn(async () => {
      events.push("bundle");
    }),
    sent: vi.fn(async () => {}),
    confirmed: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  } satisfies LaneReport;
  const waits: number[] = [];
  let clock = NOW;
  const lane = createRelayrLane({
    chain: chain.chain,
    catalog,
    provider: provider.provider,
    rpcUrls: new Map(options.chainIds.map((chainId) => [chainId, rpcUrl(chainId)])),
    signer,
    policy,
    projectsAddress: PROJECTS,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  return { amount, chain, events, hashes, lane, prepayments, provider, report, waits };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayr sponsorship lane", () => {
  test("signs forward requests with the sponsor key, prepays, polls and reports on mainnets", async () => {
    const chainIds = [8453, 10];
    const { amount, chain, events, hashes, lane, prepayments, provider, report, waits } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 2,
      projectIds: ["12", "3"],
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(report.failed).not.toHaveBeenCalled();
    expect(events).toEqual(["bundle", "prepayment"]);
    expect(report.bundle).toHaveBeenCalledWith(BUNDLE);
    expect(waits).toEqual([5_000]);
    expect(chain.prepare).toHaveBeenCalledTimes(2);
    expect(chain.signed).toHaveBeenCalledTimes(2);
    expect(chain.prepare.mock.calls[0]![1]).toMatchObject({
      chainId: 8453,
      to: TARGET,
      value: CREATION_FEE.toString(),
      label: "intent-deploy",
      dependsOn: [],
    });
    expect(chain.prepare.mock.calls[0]![2]).toBe(signer.address);
    expect(provider.create.mock.calls[0]![0].map((entry) => entry.chain)).toEqual(chainIds);
    expect(provider.polls()).toBe(2);

    expect(prepayments).toHaveLength(1);
    const prepayment = parseTransaction(prepayments[0]!);
    expect(prepayment).toMatchObject({
      chainId: 8453,
      to: RELAYR_PAYMENT_ADDRESS,
      value: amount,
      gas: 150_000n,
      nonce: 7,
      maxFeePerGas: policy.maximumFeePerGas,
      maxPriorityFeePerGas: 1_000_000n,
    });
    await expect(recoverTransactionAddress({ serializedTransaction: prepayments[0]! })).resolves.toBe(
      signer.address,
    );

    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.sent).toHaveBeenCalledWith(10, hashes.get(10), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(
      8453,
      hashes.get(8453),
      "12",
      GAS_USED * GAS_PRICE + amount,
    );
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3", 0n);
  });

  test("uses the testnet payment family for testnet deployments", async () => {
    const chainIds = [84532, 11155420];
    const { amount, hashes, lane, prepayments, report } = harness({
      chainIds,
      paymentChainId: 84532,
      hashAfter: 1,
      projectIds: ["8", "9"],
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(report.failed).not.toHaveBeenCalled();
    expect(prepayments).toHaveLength(1);
    expect(parseTransaction(prepayments[0]!)).toMatchObject({ chainId: 84532, value: amount });
    expect(report.sent).toHaveBeenCalledWith(84532, hashes.get(84532), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(
      84532,
      hashes.get(84532),
      "8",
      GAS_USED * GAS_PRICE + amount,
    );
    expect(report.confirmed).toHaveBeenCalledWith(11155420, hashes.get(11155420), "9", 0n);
  });

  test("fails only the chain whose relayed deployment reverted", async () => {
    const chainIds = [8453, 10];
    const { amount, hashes, lane, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      revertedChains: [8453],
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(report.sent).toHaveBeenCalledTimes(2);
    expect(report.failed).toHaveBeenCalledTimes(1);
    expect(report.failed).toHaveBeenCalledWith(8453, "the relayed deployment reverted");
    expect(report.confirmed).toHaveBeenCalledTimes(1);
    expect(report.confirmed).toHaveBeenCalledWith(
      10,
      hashes.get(10),
      "3",
      GAS_USED * GAS_PRICE + amount,
    );
  });

  test("resume follows an already paid bundle without paying again", async () => {
    const chainIds = [8453, 10];
    const { hashes, lane, prepayments, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
    });

    await lane.resume(intent(chainIds), chainIds, BUNDLE, report);

    expect(provider.create).not.toHaveBeenCalled();
    expect(prepayments).toHaveLength(0);
    expect(report.failed).not.toHaveBeenCalled();
    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12", 0n);
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3", 0n);
  });

  test("fails every unfinished chain when relayr never executes the bundle", async () => {
    const chainIds = [8453, 10];
    const { lane, provider, report, waits } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: Number.POSITIVE_INFINITY,
      projectIds: ["12", "3"],
    });

    await lane.resume(intent(chainIds), chainIds, BUNDLE, report);

    expect(waits).toHaveLength(181);
    expect(provider.status).toHaveBeenCalledTimes(181);
    expect(report.sent).not.toHaveBeenCalled();
    expect(report.confirmed).not.toHaveBeenCalled();
    expect(report.failed).toHaveBeenCalledWith(8453, "relayr did not execute the bundle in time");
    expect(report.failed).toHaveBeenCalledWith(10, "relayr did not execute the bundle in time");
  });

  test("fails every chain when the prepayment reverts", async () => {
    const chainIds = [8453, 10];
    const { lane, prepayments, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      revertedPayment: true,
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(prepayments).toHaveLength(1);
    expect(report.sent).not.toHaveBeenCalled();
    expect(report.failed).toHaveBeenCalledWith(8453, "the prepayment reverted");
    expect(report.failed).toHaveBeenCalledWith(10, "the prepayment reverted");
  });

  test("fails every chain and sends nothing when the quote exceeds the reservation", async () => {
    const chainIds = [8453, 10];
    const { lane, prepayments, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      amount: reservationWei(policy, chainIds.length) + 1n,
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(prepayments).toHaveLength(0);
    expect(report.sent).not.toHaveBeenCalled();
    expect(report.confirmed).not.toHaveBeenCalled();
    expect(report.failed).toHaveBeenCalledWith(8453, expect.stringContaining("maximum native funding"));
    expect(report.failed).toHaveBeenCalledWith(10, expect.stringContaining("maximum native funding"));
  });
});
