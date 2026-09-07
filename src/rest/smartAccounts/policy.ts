import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { BotGrant, RestPrincipal } from "../auth/store.js";
import { RestError } from "../core.js";
import { address, exactObject, integer } from "../protocol/abi.js";
import { fingerprint } from "./service.js";
import type {
  Allocation,
  SessionAction,
  SessionPolicyInput,
  SmartAccountBinding,
} from "./types.js";

const NATIVE = "0x000000000000000000000000000000000000EEEe" as const;
const same = isAddressEqual;
const hash = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
function fail(message: string): never {
  throw new RestError(400, "SMART_SESSION_POLICY_INVALID", message);
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    return fail("Use a bounded exact policy/allocation identifier.");
  return value;
}
export interface ReviewedSessionTarget {
  chainId: number;
  address: Address;
  runtimeCodeHash: Hex;
  kind: "erc20-exact-transfer" | "v6-core-terminal";
  reviewId: string;
}
export interface SessionReviewDependencies {
  currentBinding(
    ownerAccountId: string,
    id: Hex,
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding>;
  getGrant(ownerAccountId: string, grantId: string): Promise<BotGrant | null>;
  /** Pinned host configuration, never supplied by policy callers. */
  targets: readonly ReviewedSessionTarget[];
  assets?: readonly ReviewedSessionAsset[];
  now?: () => number;
}
export interface ReviewedSessionAsset {
  chainId: number;
  address: Address;
  assetIdentity: string;
  decimals: number;
  reviewId: string;
}
/** Produces an exact reviewable policy specification, not an assertion of onchain activation. */
export function createSessionPolicyReviewer(
  options: SessionReviewDependencies,
) {
  const now = options.now ?? Date.now;
  return {
    async review(
      principal: RestPrincipal,
      input: SessionPolicyInput,
      signal?: AbortSignal,
    ) {
      exactObject(
        input,
        [
          "bindingId",
          "grantId",
          "generation",
          "nonce",
          "validAfter",
          "durationDays",
          "maximumCalls",
          "allocations",
          "actions",
        ],
        "session",
      );
      if (!principal.scopes.includes("plan"))
        throw new RestError(
          403,
          "SMART_PLAN_SCOPE_REQUIRED",
          "The principal requires plan scope.",
        );
      if (
        !hash(input.bindingId) ||
        !hash(input.nonce) ||
        BigInt(input.nonce) === 0n
      )
        fail("Bind a verified wallet and a fresh nonzero policy nonce.");
      id(input.grantId);
      const generation = integer(input.generation, "generation");
      if (generation === 0n) fail("Policy generation must be positive.");
      const maximumCalls = integer(input.maximumCalls, "maximumCalls");
      if (maximumCalls === 0n || maximumCalls > 100000n)
        fail("A session must authorize 1–100000 calls.");
      const grant = await options.getGrant(principal.account.id, input.grantId);
      const nowSeconds = Math.floor(now() / 1000);
      if (
        !grant ||
        grant.accountId !== principal.account.id ||
        grant.revokedAt !== null ||
        grant.expiresAt <= nowSeconds ||
        !grant.scopes.includes("plan") ||
        !grant.scopes.includes("relay") ||
        (!principal.isOwner && principal.grantId !== grant.id)
      )
        throw new RestError(
          403,
          "SMART_BOT_GRANT_INVALID",
          "The session must bind this account's active bot grant and its proven key.",
        );
      if (
        ![7, 30].includes(input.durationDays) ||
        !Number.isSafeInteger(input.validAfter) ||
        input.validAfter < nowSeconds ||
        input.validAfter > nowSeconds + 86400
      )
        fail(
          "Select an explicit seven- or thirty-day session starting within one day.",
        );
      const validUntil = input.validAfter + input.durationDays * 86400;
      if (!Number.isSafeInteger(validUntil) || validUntil > grant.expiresAt)
        fail(
          "The full onchain session must expire no later than its API bot grant.",
        );
      const binding = await options.currentBinding(
        principal.account.id,
        input.bindingId,
        signal,
      );
      if (binding.ownerAccountId !== principal.account.id)
        throw new RestError(
          403,
          "SMART_BINDING_OWNER_MISMATCH",
          "The wallet belongs to another API account.",
        );
      if (
        !Array.isArray(input.allocations) ||
        input.allocations.length < 1 ||
        input.allocations.length > 16 ||
        !Array.isArray(input.actions) ||
        input.actions.length < 1 ||
        input.actions.length > 16
      )
        fail("Use 1–16 allocation groups and explicit actions.");
      const allocationIds = new Set<string>(),
        groupIds = new Set<string>(),
        coordinates = new Set<string>();
      const allocations = new Map<string, Allocation>();
      const groups = input.allocations.map((group) => {
        exactObject(group, ["id", "total", "allocations"], "allocation group");
        const groupId = id(group.id);
        if (groupIds.has(groupId)) fail("Duplicate allocation group.");
        groupIds.add(groupId);
        const total = integer(group.total, "allocation group total");
        if (
          total === 0n ||
          !Array.isArray(group.allocations) ||
          group.allocations.length < 1 ||
          group.allocations.length > 8
        )
          fail(
            "Use a positive global total and 1–8 concrete chain allocations.",
          );
        let sum = 0n;
        let units: { assetIdentity: string; decimals: number } | undefined;
        const entries = group.allocations.map((a) => {
          exactObject(a, ["id", "chainId", "asset", "limit"], "allocation");
          const aid = id(a.id),
            asset = address(a.asset, "asset", true),
            limit = integer(a.limit, "allocation limit");
          if (!Number.isSafeInteger(a.chainId) || a.chainId < 1 || limit === 0n)
            fail(
              "An allocation requires an exact chain and positive base-unit amount.",
            );
          const coordinate = `${a.chainId}:${asset.toLowerCase()}`;
          const reviewedAsset = options.assets?.find(
            (item) => item.chainId === a.chainId && same(item.address, asset),
          );
          if (
            !reviewedAsset ||
            !reviewedAsset.assetIdentity ||
            !reviewedAsset.reviewId ||
            !Number.isInteger(reviewedAsset.decimals) ||
            reviewedAsset.decimals < 0 ||
            reviewedAsset.decimals > 255
          )
            throw new RestError(
              422,
              "SMART_ASSET_UNITS_UNVERIFIED",
              "Every budget asset needs server-reviewed identity and decimals on its exact chain.",
            );
          if (
            units &&
            (units.assetIdentity !== reviewedAsset.assetIdentity ||
              units.decimals !== reviewedAsset.decimals)
          )
            fail(
              "An allocation group cannot add incompatible asset identities or decimal units. Use separate groups.",
            );
          units ??= {
            assetIdentity: reviewedAsset.assetIdentity,
            decimals: reviewedAsset.decimals,
          };
          if (allocationIds.has(aid) || coordinates.has(coordinate))
            fail(
              "An asset/chain allocation cannot be duplicated across policy groups.",
            );
          allocationIds.add(aid);
          coordinates.add(coordinate);
          sum += limit;
          const entry = {
            id: aid,
            chainId: a.chainId,
            asset,
            limit: String(limit),
            assetReviewId: reviewedAsset.reviewId,
          };
          allocations.set(aid, entry);
          return entry;
        });
        if (sum > total)
          fail("Per-chain allocations exceed the explicitly approved total.");
        return {
          id: groupId,
          ...units!,
          total: String(total),
          allocations: entries,
        };
      });
      const spentCaps = new Map<string, bigint>(),
        actionIds = new Set<string>();
      const actions = input.actions.map((action, index) => {
        if (!action || !["erc20-transfer", "v6-pay"].includes(action.kind))
          fail(
            "Only typed ERC20 transfers and closed V6 payments can be modeled; arbitrary selectors, nested calls, approvals and administration are excluded.",
          );
        exactObject(
          action,
          action.kind === "erc20-transfer"
            ? [
                "kind",
                "allocationId",
                "beneficiary",
                "perCallLimit",
                "totalLimit",
              ]
            : [
                "kind",
                "allocationId",
                "terminal",
                "projectId",
                "beneficiary",
                "perCallLimit",
                "totalLimit",
                "minReturnedTokens",
              ],
          `actions[${index}]`,
        );
        const allocation = allocations.get(id(action.allocationId));
        if (!allocation || allocation.chainId !== binding.wallet.chainId)
          fail(
            "Every action must use an allocation on the bound wallet's chain.",
          );
        const beneficiary = address(action.beneficiary, "beneficiary", true);
        if (same(beneficiary, binding.wallet.address))
          fail("A session cannot route actions back into its own account.");
        const perCall = integer(action.perCallLimit, "per-call limit"),
          total = integer(action.totalLimit, "action total");
        if (
          perCall === 0n ||
          total === 0n ||
          perCall > total ||
          total > BigInt(allocation.limit)
        )
          fail(
            "Per-call and lifetime limits must fit the allocated principal.",
          );
        spentCaps.set(
          allocation.id,
          (spentCaps.get(allocation.id) ?? 0n) + total,
        );
        if (spentCaps.get(allocation.id)! > BigInt(allocation.limit))
          fail("Independent action caps exceed their shared asset allocation.");
        const target =
          action.kind === "erc20-transfer"
            ? allocation.asset
            : address(action.terminal, "terminal", true);
        if (same(target, binding.wallet.address) || same(target, zeroAddress))
          fail("Account self-calls are forbidden.");
        if (action.kind === "erc20-transfer" && same(allocation.asset, NATIVE))
          fail("Native transfers cannot use an ERC20 policy.");
        const targetReview = options.targets.find(
          (item) =>
            item.chainId === binding.wallet.chainId &&
            same(item.address, target) &&
            item.kind ===
              (action.kind === "erc20-transfer"
                ? "erc20-exact-transfer"
                : "v6-core-terminal"),
        );
        if (!targetReview || !hash(targetReview.runtimeCodeHash))
          throw new RestError(
            422,
            "SMART_TARGET_REVIEW_REQUIRED",
            "A chain-specific reviewed token or canonical V6 terminal adapter is required.",
          );
        const selector = toFunctionSelector(
          action.kind === "erc20-transfer"
            ? "transfer(address,uint256)"
            : "pay(uint256,address,uint256,address,uint256,string,bytes)",
        );
        const key = `${target.toLowerCase()}:${selector}`;
        if (actionIds.has(key))
          fail(
            "Duplicate target/selector policies can overwrite or combine limits ambiguously.",
          );
        actionIds.add(key);
        const common = {
          kind: action.kind,
          allocationId: allocation.id,
          chainId: allocation.chainId,
          asset: allocation.asset,
          target: getAddress(target),
          targetReviewId: targetReview.reviewId,
          runtimeCodeHash: targetReview.runtimeCodeHash,
          selector,
          beneficiary,
          perCallLimit: String(perCall),
          totalLimit: String(total),
        };
        if (action.kind === "erc20-transfer")
          return {
            ...common,
            requiredEnforcement: [
              "exact-recipient-word",
              "uint256-amount-per-call-and-cumulative",
              "zero-native-value",
              "non-delegatecall",
              "no-arbitrary-signature",
            ],
          };
        const projectId = integer(action.projectId, "projectId"),
          minimum = integer(
            action.minReturnedTokens,
            "minimum returned tokens",
          );
        if (projectId === 0n)
          fail("V6 payments need an exact positive project identity.");
        return {
          ...common,
          projectId: String(projectId),
          minReturnedTokens: String(minimum),
          memo: "",
          metadata: "0x",
          requiredEnforcement: [
            "exact-project-asset-beneficiary-and-minimum",
            "canonical-empty-dynamic-memo-and-metadata",
            "amount-per-call-and-cumulative",
            "non-delegatecall",
            "no-permit2",
            ...(same(allocation.asset, NATIVE)
              ? ["cumulative-native-msg-value-cap-independent-of-amount"]
              : [
                  "zero-native-value",
                  "separately-owner-approved-finite-terminal-allowance",
                ]),
          ],
        };
      });
      const identity = {
        ownerAccountId: principal.account.id,
        bindingId: binding.id,
        chainId: binding.wallet.chainId,
        wallet: binding.wallet.address,
        grantId: grant.id,
        sessionKey: getAddress(grant.botAddress),
        generation: String(generation),
        nonce: input.nonce,
      };
      const salt = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }],
          [fingerprint(identity), input.nonce],
        ),
      );
      const policy = {
        schemaVersion: 1,
        ...identity,
        validAfter: input.validAfter,
        validUntil,
        maximumCalls: String(maximumCalls),
        salt,
        restrictToActions: true,
        signing: { mode: "disabled" },
        crossChainPermits: false,
        claimPolicies: false,
        wildcardFallback: false,
        allocations: groups,
        actions,
      };
      return {
        status: "reviewable-not-activated",
        policy,
        policyHash: fingerprint(policy),
        walletStateHash: binding.state.stateHash,
        manifestRevision: binding.state.manifestRevision,
        evidence: binding.state.evidence,
        ownerApproval: {
          required: true,
          signerRole: "smart-account-owner-threshold",
          action: "install-or-enable-exact-session-policy",
          noPermanentBotProjectPermission: true,
        },
        activationRequirements: [
          ...(binding.state.moduleConfigurationVerified
            ? []
            : ["complete-version-specific-module-state-proof"]),
          "reviewed-version-specific-policy-compiler",
          "nonzero-distinct-session-salt-support",
          "onchain-installed-policy-and-counters-proof",
          "onchain-useroperation-gas-and-prefund-budget-proof",
          "canonical-owner-activation-receipt",
        ],
        warnings: [
          "This is a policy review, not a live onchain session or an encoded installation transaction.",
          "Permission ID is not the full policy hash. Never reuse a zero-salt permission ID to renew limits or overwrite a generation.",
          "Independent chains enforce separate allocations. Retire old authority and reconcile spend before reusing allocations.",
          "ERC4337 validation may consume policy limits even when execution fails; do not assume atomic vault-style counter rollback.",
          "API grant revocation does not revoke an onchain session. Direct bot submissions remain possible until onchain revocation or expiry.",
        ],
      };
    },
  };
}
