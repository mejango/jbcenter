import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import type { ContractCatalog } from "../rest/contracts/catalog.js";
import { callsForChain } from "../intent.js";
import type { SponsorshipChain } from "../rest/sponsorship/chain.js";
import { FORWARD_REQUEST_TYPES } from "../rest/sponsorship/constants.js";
import { verifyRelayrPaymentEvent } from "../rest/sponsorship/paymentContract.js";
import { parseFamilyQuote, parseStatus, type RelayrProvider } from "../rest/sponsorship/provider.js";
import type { RelayrEntry, RelayrIndependentEntry } from "../rest/sponsorship/types.js";
import {
  decodeSafeSetupCall,
  SAFE_ABI,
  SAFE_FACTORY,
  SAFE_FACTORY_CODE_HASH,
} from "../safe.js";
import { hash as isHash, object, same } from "../rest/sponsorship/validation.js";
import {
  CREATE_TOPIC,
  LaneError,
  logSponsorEvent,
  PROJECTS_ABI,
  type DeployLane,
  type LaneReport,
  type SponsorEvents,
  type SponsorSigner,
} from "./chain.js";
import { CREATION_FEE_CEILING, reservationWei, type SponsorPolicy } from "./policy.js";
import type { DeploymentCall } from "../types.js";

const REQUEST_TTL_SECONDS = 47 * 3600;
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT_MS = 15 * 60_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const PAYMENT_GAS = 150_000n;
const NOT_EXECUTED = "relayr did not execute the bundle in time";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LaneEntry = RelayrEntry | RelayrIndependentEntry;
/** Which committed call of a chain an entry carries, and where it sits in that chain. */
type EntryRole = { chainId: number; role: "setup" | "launch"; index: number };
type EntryHash = EntryRole & { hash: Hex };

/** Center signs every forward request with its own sponsor key, so the sponsor
 * EOA is the `_msgSender()` the forwarder appends on each destination chain. */
/** Ethereum and Sepolia base fees dwarf the sponsor fee cap; pay the bundle on a rollup whenever Relayr offers one. */
const L1_CHAIN_IDS = new Set([1, 11155111]);

/** Configured payment options, rollups before L1s, in the order Relayr offered them. */
export function rankPayments<T extends { chainId: number }>(options: readonly T[], rpcUrls: Map<number, string>): T[] {
  const configured = options.filter((option) => rpcUrls.has(option.chainId));
  return [
    ...configured.filter((option) => !L1_CHAIN_IDS.has(option.chainId)),
    ...configured.filter((option) => L1_CHAIN_IDS.has(option.chainId)),
  ];
}

export function createRelayrLane(options: {
  /** One SponsorshipChain owns one RPC budget, so every deploy gets a fresh one. */
  chain: () => SponsorshipChain;
  catalog: ContractCatalog;
  provider: RelayrProvider;
  rpcUrls: Map<number, string>;
  signer: SponsorSigner;
  policy: SponsorPolicy;
  projectsAddress: Address;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  onEvent?: SponsorEvents;
}): DeployLane {
  const {
    chain: makeChain, catalog, provider, rpcUrls, signer, policy, projectsAddress,
    now = Date.now, wait = sleep, onEvent = logSponsorEvent,
  } = options;
  const client = (chainId: number) => createPublicClient({ transport: http(rpcUrls.get(chainId)) });

  function tracker(chainIds: number[], report: LaneReport) {
    const settled = new Set<number>();
    const fail = async (chainId: number, message: string) => {
      settled.add(chainId);
      await report.failed(chainId, message);
    };
    return {
      fail,
      failRest: async (message: string) => {
        for (const chainId of chainIds) if (!settled.has(chainId)) await fail(chainId, message);
      },
      confirm: async (chainId: number, transactionHash: Hex, projectId: string) => {
        settled.add(chainId);
        await report.confirmed(chainId, transactionHash, projectId);
      },
    };
  }

  /** The factory's creation code decides every predicted Safe address on a chain, so it is
   * read once per deploy and only after the factory's own runtime is the canonical one. */
  function creationCodeReader() {
    const codes = new Map<number, Hex>();
    return async (chainId: number): Promise<Hex> => {
      const cached = codes.get(chainId);
      if (cached) return cached;
      const runtime = await client(chainId).getCode({ address: SAFE_FACTORY });
      if (!runtime || keccak256(runtime) !== SAFE_FACTORY_CODE_HASH)
        throw new LaneError(
          `the Safe proxy factory runtime on chain ${chainId} is not the canonical one`,
          "SAFE_FACTORY_UNAVAILABLE",
        );
      const code = await client(chainId).readContract({
        address: SAFE_FACTORY,
        abi: SAFE_ABI,
        functionName: "proxyCreationCode",
      });
      codes.set(chainId, code);
      return code;
    };
  }

  /** Follow one submitted bundle to its destination receipts; chains that revert fail alone. */
  async function settle(options: {
    intentId: string;
    chainIds: number[];
    bundleUuid: string;
    hashesFrom: (status: unknown) => EntryHash[];
    report: LaneReport;
    track: ReturnType<typeof tracker>;
  }): Promise<void> {
    const { intentId, chainIds, bundleUuid, hashesFrom, report, track } = options;
    const launches = new Map<number, Hex>();
    const setups: EntryHash[] = [];
    const started = now();
    // A chain's outcome is its launch; a Safe creation is only observed.
    while (launches.size < chainIds.length) {
      // The bundle is paid for by the time it is polled, so an unexecuted one waits
      // for a later claim; the store retires it once it has waited a day.
      if (now() - started > POLL_LIMIT_MS) throw new LaneError(NOT_EXECUTED, "RELAYR_TIMEOUT");
      for (const found of hashesFrom(await provider.status(bundleUuid))) {
        if (!chainIds.includes(found.chainId)) continue;
        if (found.role === "setup") {
          if (!setups.some((seen) => seen.chainId === found.chainId && seen.index === found.index))
            setups.push(found);
          continue;
        }
        if (launches.has(found.chainId)) continue;
        launches.set(found.chainId, found.hash);
        await report.sent(found.chainId, found.hash, bundleUuid);
        onEvent({ event: "sent", intentId, chainId: found.chainId, transactionHash: found.hash });
      }
      if (launches.size < chainIds.length) await wait(POLL_INTERVAL_MS);
    }

    for (const chainId of chainIds) {
      const hash = launches.get(chainId)!;
      const receipt = await client(chainId).waitForTransactionReceipt({
        hash,
        confirmations: policy.confirmations,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (receipt.status !== "success") {
        await track.fail(chainId, "the relayed deployment reverted");
        continue;
      }
      const created = receipt.logs.find(
        (log) =>
          log.address.toLowerCase() === projectsAddress.toLowerCase() && log.topics[0] === CREATE_TOPIC,
      );
      if (!created?.topics[1]) {
        await track.fail(chainId, "the relayed deployment logged no Create event");
        continue;
      }
      const projectId = BigInt(created.topics[1]).toString();
      await track.confirm(chainId, hash, projectId);
      onEvent({ event: "confirmed", intentId, chainId, projectId });
    }
    await observeSetups(intentId, setups);
  }

  async function observeSetups(_intentId: string, _setups: EntryHash[]): Promise<void> {}

  return {
    async deploy(intent, chainIds, report) {
      const chain = makeChain();
      const track = tracker(chainIds, report);
      const deadline = Math.floor(now() / 1000) + REQUEST_TTL_SECONDS;
      const entries: LaneEntry[] = [];
      const roles: EntryRole[] = [];
      const proxyCreationCode = creationCodeReader();
      for (const chainId of chainIds) {
        const { setup, launch } = callsForChain(intent.envelope.deploymentCalls, chainId);
        if (!launch || !rpcUrls.has(chainId)) return track.failRest(`chain ${chainId} is not configured`);
        for (const [position, call] of setup.entries()) {
          const plan = decodeSafeSetupCall(call);
          if (!plan) return track.failRest("setup call is not a Safe creation");
          await proxyCreationCode(chainId);
          // The creation is sender-agnostic, so the sponsor's own simulation settles it.
          await client(chainId).call({ account: signer.address, to: SAFE_FACTORY, data: call.data });
          const gas = await client(chainId).estimateGas({
            account: signer.address,
            to: SAFE_FACTORY,
            data: call.data,
          });
          if (gas > policy.maximumGas) return track.failRest("setup gas above the sponsor cap");
          entries.push({ chain: chainId, target: SAFE_FACTORY, data: call.data, value: "0" });
          roles.push({ chainId, role: "setup", index: position });
        }
        const fee = await client(chainId).readContract({
          address: projectsAddress,
          abi: PROJECTS_ABI,
          functionName: "creationFee",
        });
        if (fee > CREATION_FEE_CEILING)
          return track.failRest("creation fee above the sponsor ceiling");
        // The forwarded call is simulated from the sponsor with the fee as its value,
        // so a key that cannot cover the fee makes the node reject the simulation.
        const balance = await client(chainId).getBalance({ address: signer.address });
        if (balance < fee)
          throw new LaneError(
            `sponsor holds less than the creation fee on chain ${chainId} by ${fee - balance} wei`,
            "SPONSOR_UNFUNDED",
          );
        const prepared = await chain.prepare(
          catalog,
          {
            chainId,
            to: launch.to,
            data: launch.data,
            value: fee.toString(),
            label: "intent-deploy",
            dependsOn: [],
            decoded: null,
          },
          signer.address,
          entries.length,
          deadline,
        );
        if (BigInt(prepared.message.gas) > policy.maximumGas)
          return track.failRest(`gas ${prepared.message.gas} exceeds the sponsor cap`);
        const signature = await signer.signTypedData({
          domain: prepared.domain,
          types: FORWARD_REQUEST_TYPES,
          primaryType: "ForwardRequest",
          message: {
            from: prepared.message.from,
            to: prepared.message.to,
            value: BigInt(prepared.message.value),
            gas: BigInt(prepared.message.gas),
            nonce: BigInt(prepared.message.nonce),
            deadline: Number(prepared.message.deadline),
            data: prepared.message.data,
          },
        });
        entries.push(await chain.signed(prepared, signature));
        roles.push({ chainId, role: "launch", index: setup.length });
      }

      const quote = parseFamilyQuote(
        await provider.create(entries),
        entries,
        now(),
        reservationWei(policy, entries.length),
      );
      const candidates = rankPayments(quote.payments, rpcUrls);
      if (candidates.length === 0) return track.failRest("relayr returned no payment option on a configured chain");
      // The key may hold funds on only some of the offered chains; pay from the first rollup that
      // covers it, and name the best-ranked chain's shortfall when none of them does.
      let chosen: { payment: (typeof candidates)[number]; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; maxFeePerGas: bigint } | undefined;
      let shortfall: { chainId: number; wei: bigint } | undefined;
      for (const candidate of candidates) {
        const candidateClient = client(candidate.chainId);
        const fees = await candidateClient.estimateFeesPerGas();
        const cap = fees.maxFeePerGas > policy.maximumFeePerGas ? policy.maximumFeePerGas : fees.maxFeePerGas;
        const balance = await candidateClient.getBalance({ address: signer.address });
        const needed = BigInt(candidate.value) + PAYMENT_GAS * cap;
        if (balance >= needed) {
          chosen = { payment: candidate, fees, maxFeePerGas: cap };
          break;
        }
        shortfall ??= { chainId: candidate.chainId, wei: needed - balance };
      }
      if (!chosen) {
        // The ranked candidates are non-empty above, so an unchosen payment left a shortfall.
        const short = shortfall!;
        throw new LaneError(
          `sponsor holds less than the prepayment on chain ${short.chainId} by ${short.wei} wei`,
          "SPONSOR_UNFUNDED",
        );
      }
      const { payment, fees, maxFeePerGas } = chosen;
      const paymentClient = client(payment.chainId);
      // The bundle is durable before any ETH leaves the key, so a re-claim resumes it.
      await report.bundle(quote.bundleUuid);
      onEvent({
        event: "bundle",
        intentId: intent.id,
        bundleUuid: quote.bundleUuid,
        chainIds,
        paymentChainId: payment.chainId,
        offeredPaymentChainIds: quote.payments.map((option) => option.chainId),
      });
      const raw = await signer.signTransaction({
        type: "eip1559",
        chainId: payment.chainId,
        to: payment.to,
        data: payment.data,
        value: BigInt(payment.value),
        gas: PAYMENT_GAS,
        maxFeePerGas,
        maxPriorityFeePerGas:
          fees.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : fees.maxPriorityFeePerGas,
        nonce: await paymentClient.getTransactionCount({ address: signer.address, blockTag: "pending" }),
      });
      // The budget charge must not be undone by a payment-chain reorg.
      const paymentReceipt = await paymentClient.waitForTransactionReceipt({
        hash: await paymentClient.sendRawTransaction({ serializedTransaction: raw }),
        confirmations: policy.confirmations,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (paymentReceipt.status !== "success") return track.failRest("the prepayment reverted");
      verifyRelayrPaymentEvent(paymentReceipt.logs, quote.bundleUuid, payment.value, payment.deadline);
      // The money is gone whatever the destinations do, so the budget learns it now.
      const paymentCost =
        paymentReceipt.gasUsed * paymentReceipt.effectiveGasPrice + BigInt(payment.value);
      await report.paid(chainIds[0]!, paymentCost);
      onEvent({
        event: "payment",
        intentId: intent.id,
        chainId: payment.chainId,
        transactionHash: paymentReceipt.transactionHash,
        wei: paymentCost.toString(),
      });

      await settle({
        intentId: intent.id,
        chainIds,
        bundleUuid: quote.bundleUuid,
        hashesFrom: (status) => {
          const found: EntryHash[] = [];
          for (const item of parseStatus(status, quote)) {
            const role = roles[item.step];
            if (item.hash && role) found.push({ ...role, hash: item.hash });
          }
          return found;
        },
        report,
        track,
      });
    },

    // The prepayment of a resumed bundle was spent by the attempt that submitted it.
    async resume(intent, chainIds, bundleUuid, report) {
      const track = tracker(chainIds, report);
      await settle({
        intentId: intent.id,
        chainIds,
        bundleUuid,
        hashesFrom: (status) =>
          resumedEntries(status, bundleUuid, intent.envelope.deploymentCalls),
        report,
        track,
      });
    },
  };
}

/** A resumed bundle has no retained quote to bind against, so entries are read
 * defensively: a Safe creation is the factory carrying one of the chain's committed
 * setup calls, and the one remaining call on a chain is its launch. */
function resumedEntries(
  status: unknown,
  bundleUuid: string,
  calls: readonly DeploymentCall[],
): EntryHash[] {
  if (!object(status) || status.bundle_uuid !== bundleUuid || !Array.isArray(status.transactions))
    throw new LaneError(
      "the execution service status does not match the stored bundle",
      "RELAYR_INVALID_STATUS",
    );
  const found: EntryHash[] = [];
  for (const item of status.transactions) {
    if (!object(item) || !object(item.request) || !object(item.status)) continue;
    const request = item.request;
    const details = object(item.status.data) ? item.status.data : {};
    const nested = object(details.transaction) ? details.transaction.hash : undefined;
    const transactionHash = details.hash ?? nested;
    const chainId = request.chain;
    if (typeof chainId !== "number" || !isHash(transactionHash)) continue;
    const { setup } = callsForChain(calls, chainId);
    const index =
      typeof request.target === "string" && same(request.target, SAFE_FACTORY)
        ? setup.findIndex(
            (call) => typeof request.data === "string" && same(request.data, call.data),
          )
        : -1;
    found.push(
      index < 0
        ? { chainId, role: "launch", index: setup.length, hash: transactionHash }
        : { chainId, role: "setup", index, hash: transactionHash },
    );
  }
  const launches = found.filter((item) => item.role === "launch").map((item) => item.chainId);
  if (new Set(launches).size !== launches.length)
    throw new LaneError(
      "the execution service status does not match the stored bundle",
      "RELAYR_INVALID_STATUS",
    );
  return found;
}
