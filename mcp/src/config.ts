import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from './domain/errors.js';
import type { ChainId } from './domain/types.js';

export const CHAIN_IDS = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614] as const;
export interface Config {
  production: boolean;
  host: string;
  port: number;
  publicOrigin: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  planSecret: string;
  planTtlSeconds: number;
  rpcUrls: Partial<Record<ChainId, string>>;
  centerUrl: string;
  centerOrigin?: string;
  bendystrawMainnetUrl?: string;
  bendystrawTestnetUrl?: string;
  knowledgePath?: string;
  maxConcurrentRequests: number;
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new DomainError(
      'INVALID_CONFIG',
      'Upstream URLs must use HTTP(S) without user information or fragments.',
    );
  return url.toString().replace(/\/$/, '');
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  return z.coerce
    .number()
    .int()
    .min(min)
    .max(max)
    .parse(value ?? fallback);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const publicUrl = new URL(
    env.PUBLIC_ORIGIN ?? (production ? 'https://juicebox.diy' : 'http://localhost:3000'),
  );
  if (
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password ||
    !['https:', 'http:'].includes(publicUrl.protocol)
  )
    throw new DomainError('INVALID_CONFIG', 'PUBLIC_ORIGIN must be a plain HTTP(S) origin.');
  if (production && publicUrl.protocol !== 'https:')
    throw new DomainError('INVALID_CONFIG', 'PUBLIC_ORIGIN must use HTTPS in production.');
  if (env.PLAN_SECRET !== undefined && Buffer.byteLength(env.PLAN_SECRET) < 32)
    throw new DomainError(
      'INVALID_CONFIG',
      'PLAN_SECRET must contain at least 32 bytes of secret entropy.',
    );
  if (production && !env.PLAN_SECRET)
    throw new DomainError(
      'INVALID_CONFIG',
      'Production requires a stable PLAN_SECRET shared by all replicas.',
    );
  const centerUrl = endpoint(env.JBCENTER_URL ?? 'https://juicebox.center');
  const rpcUrls: Config['rpcUrls'] = {};
  for (const chainId of CHAIN_IDS)
    rpcUrls[chainId] = endpoint(env[`RPC_URL_${chainId}`] ?? `${centerUrl}/v1/rpc/${chainId}`);
  const allowedHosts = [
    ...new Set([
      publicUrl.hostname,
      ...(production ? [] : ['localhost', '127.0.0.1', '[::1]']),
      ...(env.ALLOWED_HOSTS?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? []),
    ]),
  ];
  const allowedOrigins = [
    ...new Set([
      publicUrl.origin,
      ...(env.ALLOWED_ORIGINS?.split(',').map((value) => new URL(value.trim()).origin) ?? []),
    ]),
  ];
  return {
    production,
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port: integer(env.PORT, 3000, 0, 65535),
    publicOrigin: publicUrl.origin,
    allowedHosts,
    allowedOrigins,
    planSecret: env.PLAN_SECRET ?? randomBytes(32).toString('hex'),
    planTtlSeconds: integer(env.PLAN_TTL_SECONDS, 300, 30, 1800),
    rpcUrls,
    centerUrl,
    ...(env.JBCENTER_ORIGIN ? { centerOrigin: new URL(env.JBCENTER_ORIGIN).origin } : {}),
    ...(env.BENDYSTRAW_MAINNET_URL
      ? { bendystrawMainnetUrl: endpoint(env.BENDYSTRAW_MAINNET_URL) }
      : {}),
    ...(env.BENDYSTRAW_TESTNET_URL
      ? { bendystrawTestnetUrl: endpoint(env.BENDYSTRAW_TESTNET_URL) }
      : {}),
    ...(env.KNOWLEDGE_PATH ? { knowledgePath: env.KNOWLEDGE_PATH } : {}),
    maxConcurrentRequests: integer(env.MAX_CONCURRENT_REQUESTS, 16, 1, 128),
  };
}
