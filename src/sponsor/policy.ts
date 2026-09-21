export const SPONSORED_MAINNETS = [10, 8453, 42161] as const;
export const SPONSORED_TESTNETS = [11155111, 11155420, 84532, 421614] as const;
const CREATION_FEE_CEILING = 100_000_000_000_000n; // 0.0001 ETH today; MAX_CREATION_FEE on chain is 0.001 ETH

export type SponsorPolicy = {
  paused: boolean;
  perRequesterPerDay: number;
  dailyBudgetWei: bigint;
  maximumGas: bigint;
  maximumFeePerGas: bigint;
  confirmations: number;
};

export type SponsorRuntime = {
  policy: SponsorPolicy;
  kick(): void;
};

export function sponsorFamily(chainIds: number[]): "mainnet" | "testnet" | null {
  if (chainIds.length && chainIds.every((id) => (SPONSORED_MAINNETS as readonly number[]).includes(id))) {
    return "mainnet";
  }
  if (chainIds.length && chainIds.every((id) => (SPONSORED_TESTNETS as readonly number[]).includes(id))) {
    return "testnet";
  }
  return null;
}

export function reservationWei(policy: SponsorPolicy, chainCount: number): bigint {
  return BigInt(chainCount) * (policy.maximumGas * policy.maximumFeePerGas + CREATION_FEE_CEILING);
}

export function readSponsorPolicy(env: NodeJS.ProcessEnv): SponsorPolicy {
  const int = (name: string, fallback: string) => {
    const value = env[name] ?? fallback;
    if (!/^[0-9]{1,30}$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return {
    paused: env.SPONSOR_PAUSED === "1",
    perRequesterPerDay: Number(int("SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY", "5")),
    dailyBudgetWei: BigInt(int("SPONSOR_DAILY_BUDGET_WEI", "50000000000000000")),
    maximumGas: BigInt(int("SPONSOR_MAX_GAS", "8000000")),
    maximumFeePerGas: BigInt(int("SPONSOR_MAX_FEE_PER_GAS", "1000000000")),
    confirmations: Number(int("SPONSOR_CONFIRMATIONS", "2")),
  };
}
