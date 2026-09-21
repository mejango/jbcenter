import { createPublicClient, http, type Address, type Hex } from "viem";
import type { ContractCatalog } from "../rest/contracts/catalog.js";
import type { SponsorshipChain } from "../rest/sponsorship/chain.js";
import { FORWARD_REQUEST_TYPES } from "../rest/sponsorship/constants.js";
import { verifyRelayrPaymentEvent } from "../rest/sponsorship/paymentContract.js";
import { parseFamilyQuote, parseStatus, type RelayrProvider } from "../rest/sponsorship/provider.js";
import type { RelayrEntry } from "../rest/sponsorship/types.js";
import { hash as isHash, object } from "../rest/sponsorship/validation.js";
import {
  CREATE_TOPIC,
  PROJECTS_ABI,
  type DeployLane,
  type LaneReport,
  type SponsorSigner,
} from "./chain.js";
import { reservationWei, type SponsorPolicy } from "./policy.js";

const REQUEST_TTL_SECONDS = 47 * 3600;
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT_MS = 15 * 60_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const PAYMENT_GAS = 150_000n;
const NOT_EXECUTED = "relayr did not execute the bundle in time";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Center signs every forward request with its own sponsor key, so the sponsor
 * EOA is the `_msgSender()` the forwarder appends on each destination chain. */
export function createRelayrLane(options: {
  chain: SponsorshipChain;
  catalog: ContractCatalog;
  provider: RelayrProvider;
  rpcUrls: Map<number, string>;
  signer: SponsorSigner;
  policy: SponsorPolicy;
  projectsAddress: Address;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): DeployLane {
  const {
    chain, catalog, provider, rpcUrls, signer, policy, projectsAddress,
    now = Date.now, wait = sleep,
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
      confirm: async (chainId: number, transactionHash: Hex, projectId: string, spentWei: bigint) => {
        settled.add(chainId);
        await report.confirmed(chainId, transactionHash, projectId, spentWei);
      },
    };
  }

  /** Follow one submitted bundle to its destination receipts. The payment cost lands
   * on the first chain that actually confirms; chains that revert fail alone. */
  async function settle(options: {
    chainIds: number[];
    bundleUuid: string;
    hashesFrom: (status: unknown) => Map<number, Hex>;
    paymentCost: bigint;
    report: LaneReport;
    track: ReturnType<typeof tracker>;
  }): Promise<void> {
    const { chainIds, bundleUuid, hashesFrom, paymentCost, report, track } = options;
    const hashes = new Map<number, Hex>();
    const started = now();
    while (hashes.size < chainIds.length) {
      if (now() - started > POLL_LIMIT_MS) return track.failRest(NOT_EXECUTED);
      for (const [chainId, hash] of hashesFrom(await provider.status(bundleUuid))) {
        if (!chainIds.includes(chainId) || hashes.has(chainId)) continue;
        hashes.set(chainId, hash);
        await report.sent(chainId, hash, bundleUuid);
      }
      if (hashes.size < chainIds.length) await wait(POLL_INTERVAL_MS);
    }

    let first = true;
    for (const chainId of chainIds) {
      const hash = hashes.get(chainId)!;
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
      await track.confirm(chainId, hash, BigInt(created.topics[1]).toString(), first ? paymentCost : 0n);
      first = false;
    }
  }

  return {
    async deploy(intent, chainIds, report) {
      const track = tracker(chainIds, report);
      try {
        const deadline = Math.floor(now() / 1000) + REQUEST_TTL_SECONDS;
        const entries: RelayrEntry[] = [];
        for (const [index, chainId] of chainIds.entries()) {
          const call = intent.envelope.deploymentCalls.find((item) => item.chainId === chainId);
          if (!call || !rpcUrls.has(chainId)) return track.failRest(`chain ${chainId} is not configured`);
          const fee = await client(chainId).readContract({
            address: projectsAddress,
            abi: PROJECTS_ABI,
            functionName: "creationFee",
          });
          const prepared = await chain.prepare(
            catalog,
            {
              chainId,
              to: call.to,
              data: call.data,
              value: fee.toString(),
              label: "intent-deploy",
              dependsOn: [],
              decoded: null,
            },
            signer.address,
            index,
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
        }

        const quote = parseFamilyQuote(
          await provider.create(entries),
          entries,
          now(),
          reservationWei(policy, chainIds.length),
        );
        // The bundle is durable before any ETH leaves the key, so a re-claim resumes it.
        await report.bundle(quote.bundleUuid);
        const payment = quote.payments.find((option) => rpcUrls.has(option.chainId));
        if (!payment) return track.failRest("relayr returned no payment option on a configured chain");
        const paymentClient = client(payment.chainId);
        const fees = await paymentClient.estimateFeesPerGas();
        const maxFeePerGas =
          fees.maxFeePerGas > policy.maximumFeePerGas ? policy.maximumFeePerGas : fees.maxFeePerGas;
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
        const paymentReceipt = await paymentClient.waitForTransactionReceipt({
          hash: await paymentClient.sendRawTransaction({ serializedTransaction: raw }),
          confirmations: 1,
          timeout: RECEIPT_TIMEOUT_MS,
        });
        if (paymentReceipt.status !== "success") return track.failRest("the prepayment reverted");
        verifyRelayrPaymentEvent(paymentReceipt.logs, quote.bundleUuid, payment.value, payment.deadline);

        await settle({
          chainIds,
          bundleUuid: quote.bundleUuid,
          hashesFrom: (status) => {
            const found = new Map<number, Hex>();
            for (const item of parseStatus(status, quote)) {
              const chainId = entries[item.step]?.chain;
              if (item.hash && chainId !== undefined) found.set(chainId, item.hash);
            }
            return found;
          },
          paymentCost: paymentReceipt.gasUsed * paymentReceipt.effectiveGasPrice + BigInt(payment.value),
          report,
          track,
        });
      } catch (error) {
        await track.failRest(error instanceof Error ? error.message : String(error));
      }
    },

    async resume(_intent, chainIds, bundleUuid, report) {
      const track = tracker(chainIds, report);
      try {
        await settle({
          chainIds,
          bundleUuid,
          hashesFrom: (status) => resumedHashes(status, bundleUuid),
          // The prepayment of a resumed bundle was spent by the attempt that submitted it.
          paymentCost: 0n,
          report,
          track,
        });
      } catch (error) {
        await track.failRest(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** A resumed bundle has no retained quote to bind against, so hashes are read
 * defensively and the deployment verifier stays the authority on what each did. */
function resumedHashes(status: unknown, bundleUuid: string): Map<number, Hex> {
  if (!object(status) || status.bundle_uuid !== bundleUuid || !Array.isArray(status.transactions))
    throw new Error("the execution service status does not match the stored bundle");
  const hashes = new Map<number, Hex>();
  for (const item of status.transactions) {
    if (!object(item) || !object(item.request) || !object(item.status)) continue;
    const details = object(item.status.data) ? item.status.data : {};
    const nested = object(details.transaction) ? details.transaction.hash : undefined;
    const transactionHash = details.hash ?? nested;
    if (typeof item.request.chain === "number" && isHash(transactionHash))
      hashes.set(item.request.chain, transactionHash);
  }
  return hashes;
}
