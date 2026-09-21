export function verifyRelayrPaymentReference(): Promise<{
  executableMatches: boolean; upstreamSourceVerified: boolean; runtimeHash: string;
}>;
