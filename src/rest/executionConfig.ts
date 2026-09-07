import { getAddress, isAddress, type Address } from "viem";
import { RestError } from "./core.js";
import { createConfiguredSmartAccountStack } from "./smartAccounts/stack/config.js";
import { LEGACY_COMPILER_RUNTIME_HASHES } from "./smartAccounts/compiler.js";
import type { ReviewedSessionPaymaster } from "./smartAccounts/policy.js";
import {
  createPimlicoV7PaymasterPolicy,
  UserOperationProvider,
} from "./userOperations/provider.js";
import type {
  UserOperationProviderConfig,
  UserOperationGasPolicy,
} from "./userOperations/types.js";
import type { UserOperationChainPolicy } from "./userOperations/service.js";

const CHAIN_IDS = [
  1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420,
] as const;
const GAS_FIELDS = [
  "maximumCallGas",
  "maximumVerificationGas",
  "maximumPreVerificationGas",
  "maximumPaymasterVerificationGas",
  "maximumPaymasterPostOpGas",
  "maximumFeePerGas",
  "maximumPriorityFeePerGas",
  "maximumCost",
] as const;
type ConfiguredStack = Awaited<
  ReturnType<typeof createConfiguredSmartAccountStack>
>;
export interface RestExecutionConfiguration {
  stacks: ConfiguredStack[];
  providers: UserOperationProviderConfig[];
  policies: UserOperationChainPolicy[];
  paymasters: ReviewedSessionPaymaster[];
}
function invalid(message: string): never {
  throw new RestError(500, "REST_EXECUTION_CONFIG_INVALID", message);
}
function object(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return invalid(
      "Execution configuration contains an invalid object or unsupported field.",
    );
  return value as Record<string, unknown>;
}
function endpoint(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return invalid("Configure bounded fixed HTTPS provider URLs.");
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname
    )
      return invalid(
        "Configure fixed HTTPS provider URLs without embedded user credentials or fragments.",
      );
    return url.href;
  } catch {
    return invalid("A configured provider URL is invalid.");
  }
}
function amount(value: unknown, bits: number, zeroAllowed = false): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 78
  )
    return invalid(
      "Every provider gas ceiling must be an explicit canonical decimal integer string.",
    );
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits) || (!zeroAllowed && n === 0n))
    return invalid(
      "A provider gas ceiling is outside its supported integer bounds.",
    );
  return n;
}
function gasPolicy(chainId: number, input: unknown): UserOperationGasPolicy {
  const value = object(input, GAS_FIELDS);
  const result = {
    id: `operator-hosted-gas-${chainId}`,
    maximumCallGas: amount(value.maximumCallGas, 128),
    maximumVerificationGas: amount(value.maximumVerificationGas, 128),
    maximumPreVerificationGas: amount(value.maximumPreVerificationGas, 128),
    maximumPaymasterVerificationGas: amount(
      value.maximumPaymasterVerificationGas,
      128,
    ),
    maximumPaymasterPostOpGas: amount(
      value.maximumPaymasterPostOpGas,
      128,
      true,
    ),
    maximumFeePerGas: amount(value.maximumFeePerGas, 128),
    maximumPriorityFeePerGas: amount(value.maximumPriorityFeePerGas, 128, true),
    maximumCost: amount(value.maximumCost, 256),
    requirePaymaster: true,
  };
  if (result.maximumPriorityFeePerGas > result.maximumFeePerGas)
    return invalid(
      "The priority fee ceiling cannot exceed the total fee ceiling.",
    );
  return result;
}

/** Startup configuration only. Never mount this parser as an HTTP endpoint or serialize its returned provider URLs. */
export async function readRestExecutionConfiguration(
  envOrJson: Record<string, string | undefined> | string = process.env,
): Promise<RestExecutionConfiguration> {
  const raw =
    typeof envOrJson === "string" ? envOrJson : envOrJson.REST_ERC4337_CONFIG;
  let entries: unknown[] = [];
  if (raw !== undefined) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      Buffer.byteLength(raw) > 65536
    )
      invalid("REST_ERC4337_CONFIG must be bounded nonempty JSON.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalid("REST_ERC4337_CONFIG must contain valid JSON.");
    }
    const value = object(parsed, ["chains"]);
    if (!Array.isArray(value.chains) || value.chains.length > 8)
      invalid(
        "Execution configuration must contain at most eight explicit chains.",
      );
    entries = value.chains;
  }
  const stacks = new Map<number, ConfiguredStack>();
  const providers: UserOperationProviderConfig[] = [];
  const policies: UserOperationChainPolicy[] = [];
  const paymasters: ReviewedSessionPaymaster[] = [];
  const usedChains = new Set<number>();
  for (const entry of entries) {
    const value = object(entry, [
      "chainId",
      "bundlerUrl",
      "paymasterUrl",
      "paymasterPolicyId",
      "sessionGuardAddress",
      "gas",
      "confirmations",
    ]);
    if (
      typeof value.chainId !== "number" ||
      !Number.isSafeInteger(value.chainId) ||
      !(CHAIN_IDS as readonly number[]).includes(value.chainId) ||
      usedChains.has(value.chainId)
    )
      invalid("Provider chains must be supported, explicit and unique.");
    const chainId = value.chainId;
    usedChains.add(chainId);
    if (
      typeof value.paymasterPolicyId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(value.paymasterPolicyId)
    )
      invalid("A bounded hosted sponsorship policy identifier is required.");
    let guardAddress: Address | undefined;
    if (value.sessionGuardAddress !== undefined) {
      if (
        typeof value.sessionGuardAddress !== "string" ||
        !isAddress(value.sessionGuardAddress) ||
        BigInt(value.sessionGuardAddress) === 0n
      )
        invalid(
          "The operator guard address must be a valid nonzero deployment address.",
        );
      guardAddress = getAddress(value.sessionGuardAddress);
    }
    const confirmations = value.confirmations ?? 1;
    if (
      typeof confirmations !== "number" ||
      !Number.isSafeInteger(confirmations) ||
      confirmations < 1 ||
      confirmations > 1024
    )
      invalid(
        "Confirmation requirements must be an integer from one through 1024.",
      );
    const gas = gasPolicy(chainId, value.gas);
    const stack = await createConfiguredSmartAccountStack({
      chainId,
      ...(guardAddress
        ? {
            sessionGuard: {
              address: guardAddress,
              runtimeCodeHash: LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard,
            },
          }
        : {}),
    });
    stacks.set(chainId, stack);
    const paymasterPolicy = createPimlicoV7PaymasterPolicy({
      chainId,
      policyId: value.paymasterPolicyId,
      context: { sponsorshipPolicyId: value.paymasterPolicyId },
    });
    if (
      paymasterPolicy.contract.address.toLowerCase() !==
        stack.paymaster.address.toLowerCase() ||
      paymasterPolicy.contract.runtimeCodeHash !==
        stack.paymaster.runtimeCodeHash
    )
      invalid(
        "The provider profile does not match the reviewed stack paymaster.",
      );
    providers.push({
      chainId,
      providerId: `operator-pimlico-${chainId}`,
      entryPoint: stack.entryPoint,
      bundlerUrl: endpoint(value.bundlerUrl),
      paymasterUrl: endpoint(value.paymasterUrl),
      paymasterPolicy,
    });
    policies.push({ chainId, gas, confirmations });
    paymasters.push({
      chainId,
      address: stack.paymaster.address,
      runtimeCodeHash: stack.paymaster.runtimeCodeHash,
      reviewId: stack.paymaster.profileId,
    });
  }
  // The provider constructor independently validates the finalized server-owned transport config without making requests.
  new UserOperationProvider(providers);
  for (const chainId of CHAIN_IDS)
    if (!stacks.has(chainId))
      stacks.set(chainId, await createConfiguredSmartAccountStack({ chainId }));
  return {
    stacks: CHAIN_IDS.map((chainId) => stacks.get(chainId)!),
    providers,
    policies,
    paymasters,
  };
}
