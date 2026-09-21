export type FirstPartyApplication = {
  origin: string;
  walletCallbacks: readonly string[];
  /** How long a sign-in (an app grant) lasts, in seconds; an hour when absent, at most 90 days. */
  grantLifetimeSeconds?: number;
};

function applications(origins: readonly string[]): readonly FirstPartyApplication[] {
  return Object.freeze(origins.map(origin => Object.freeze({ origin, walletCallbacks: Object.freeze([]) })));
}

const PRODUCTION_APPLICATIONS = applications([
  "https://juicebox.money",
  "https://revnet.money",
  "https://eth.shop",
  "https://succulent.money",
  "https://homerun.money",
  "https://beep.biz",
]);
const DEV_APPLICATIONS = applications([
  "https://dev.juicebox.money",
  "https://dev.revnet.money",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://dev.eth.shop",
  "http://localhost:3003",
  "https://dev.succulent.money",
  "http://localhost:3004",
  "http://localhost:3010",
  "http://localhost:3014",
  "http://127.0.0.1:8787",
]);

/** The shared trusted configuration. Empty callbacks admit no wallet handoff. */
export function firstPartyForEnvironment(environment = process.env.RAILWAY_ENVIRONMENT_NAME): readonly FirstPartyApplication[] {
  return environment === "dev" ? DEV_APPLICATIONS : PRODUCTION_APPLICATIONS;
}

export function originsForEnvironment(environment = process.env.RAILWAY_ENVIRONMENT_NAME): readonly string[] {
  return firstPartyForEnvironment(environment).map(application => application.origin);
}
