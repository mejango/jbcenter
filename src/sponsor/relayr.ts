import { createPublicClient, http, type Address, type Hex } from "viem";
import type { ContractCatalog } from "../rest/contracts/catalog.js";
import type { SponsorshipChain } from "../rest/sponsorship/chain.js";
import { FORWARD_REQUEST_TYPES } from "../rest/sponsorship/constants.js";
import { verifyRelayrPaymentEvent } from "../rest/sponsorship/paymentContract.js";
import { parseFamilyQuote, parseStatus, type RelayrProvider } from "../rest/sponsorship/provider.js";
import type { RelayrEntry } from "../rest/sponsorship/types.js";
import { CREATE_TOPIC, PROJECTS_ABI, type DeployLane, type SponsorSigner } from "./chain.js";
import { reservationWei, type SponsorPolicy } from "./policy.js";

const REQUEST_TTL_SECONDS = 47 * 3600;
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT_MS = 15 * 60_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const PAYMENT_GAS = 150_000n;

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
}): DeployLane {
  const { chain, catalog, provider, rpcUrls, signer, policy, projectsAddress, now = Date.now } = options;
  const client = (chainId: number) => createPublicClient({ transport: http(rpcUrls.get(chainId)) });

  return {
    async deploy(intent, chainIds, report) {
      const settled = new Set<number>();
      const fail = async (chainId: number, message: string) => {
        settled.add(chainId);
        await report.failed(chainId, message);
      };
      const failAll = async (message: string) => {
        for (const chainId of chainIds) if (!settled.has(chainId)) await fail(chainId, message);
      };
      try {
        const deadline = Math.floor(now() / 1000) + REQUEST_TTL_SECONDS;
        const entries: RelayrEntry[] = [];
        for (const [index, chainId] of chainIds.entries()) {
          const call = intent.envelope.deploymentCalls.find((item) => item.chainId === chainId);
          if (!call || !rpcUrls.has(chainId)) return failAll(`chain ${chainId} is not configured`);
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
            return failAll(`gas ${prepared.message.gas} exceeds the sponsor cap`);
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
        const payment = quote.payments.find((option) => rpcUrls.has(option.chainId));
        if (!payment) return failAll("relayr returned no payment option on a configured chain");
        const paymentClient = client(payment.chainId);
        const fees = await paymentClient.estimateFeesPerGas();
        const raw = await signer.signTransaction({
          type: "eip1559",
          chainId: payment.chainId,
          to: payment.to,
          data: payment.data,
          value: BigInt(payment.value),
          gas: PAYMENT_GAS,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          nonce: await paymentClient.getTransactionCount({ address: signer.address, blockTag: "pending" }),
        });
        const paymentReceipt = await paymentClient.waitForTransactionReceipt({
          hash: await paymentClient.sendRawTransaction({ serializedTransaction: raw }),
          confirmations: 1,
          timeout: RECEIPT_TIMEOUT_MS,
        });
        verifyRelayrPaymentEvent(paymentReceipt.logs, quote.bundleUuid, payment.value, payment.deadline);
        const paymentCost = paymentReceipt.gasUsed * paymentReceipt.effectiveGasPrice + BigInt(payment.value);

        const hashes = new Map<number, Hex>();
        const started = now();
        while (hashes.size < chainIds.length) {
          if (now() - started > POLL_LIMIT_MS) return failAll("relayr did not execute the bundle in time");
          for (const item of parseStatus(await provider.status(quote.bundleUuid), quote)) {
            const chainId = entries[item.step]?.chain;
            if (item.hash && chainId !== undefined && !hashes.has(chainId)) {
              hashes.set(chainId, item.hash);
              await report.sent(chainId, item.hash, quote.bundleUuid);
            }
          }
          if (hashes.size < chainIds.length)
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        let first = true;
        for (const chainId of chainIds) {
          const hash = hashes.get(chainId)!;
          const receipt = await client(chainId).waitForTransactionReceipt({
            hash,
            confirmations: policy.confirmations,
            timeout: RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status !== "success") return fail(chainId, "the relayed deployment reverted");
          const created = receipt.logs.find(
            (log) =>
              log.address.toLowerCase() === projectsAddress.toLowerCase() && log.topics[0] === CREATE_TOPIC,
          );
          if (!created?.topics[1]) return fail(chainId, "the relayed deployment logged no Create event");
          await report.confirmed(chainId, hash, BigInt(created.topics[1]).toString(), first ? paymentCost : 0n);
          settled.add(chainId);
          first = false;
        }
      } catch (error) {
        await failAll(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
