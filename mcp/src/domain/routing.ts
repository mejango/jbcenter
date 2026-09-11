import { z } from 'zod';
import { jbRouterTerminalRegistryAbi } from '@bananapus/nana-sdk-core';
import { v6Address } from '@bananapus/nana-sdk-core/v6';
import { isAddress, isAddressEqual, type Address, type PublicClient } from 'viem';
import { deploymentAddresses, routerGatewayAbi } from '../services/rollout.js';
import { DomainError } from './errors.js';
import { addressSchema, hashSchema, projectSchema } from './schemas.js';
import type { ProjectRef } from './types.js';

const terminalTokenSchema = addressSchema.refine(
  (value) => BigInt(value) !== 0n,
  'Use the Juicebox native-token sentinel, not address(0).',
);
export const routingSchema = z
  .object({
    project: projectSchema,
    tokens: z
      .array(terminalTokenSchema)
      .max(8)
      .optional()
      .describe(
        'Additional tokens whose primary terminal and buyback pool should be inspected. Current terminal contexts are discovered automatically.',
      ),
    pairs: z
      .array(z.object({ tokenIn: terminalTokenSchema, tokenOut: terminalTokenSchema }).strict())
      .max(4)
      .optional()
      .describe(
        'Optional pairs for router pool discovery. Discovery is not an executable swap quote.',
      ),
    pendingCallIds: z
      .array(hashSchema)
      .max(8)
      .optional()
      .describe(
        'Gateway pending-call IDs from queue events. IDs are global to the gateway; commitments and failures alone do not establish the source project, token or amount.',
      ),
  })
  .strict();

const action = { project: projectSchema, account: addressSchema };
export const prepareBuybackPoolSchema = z
  .object({
    ...action,
    terminalToken: terminalTokenSchema,
    fee: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .describe('Static Uniswap V4 pool fee in hundredths of a basis point; 3000 = 0.3%.'),
    tickSpacing: z.number().int().min(1).max(32767),
    twapWindowSeconds: z
      .number()
      .int()
      .min(300)
      .max(172800)
      .describe(
        'The current hook maps registration at 172800 to its 1800-second default; retired 1.1.1 and v1 hooks store 172800 unchanged. Use the TWAP update tool afterward for an explicit 172800-second window on the current hook.',
      ),
  })
  .strict();
export const prepareBuybackTwapSchema = z
  .object({
    ...action,
    terminalToken: terminalTokenSchema,
    twapWindowSeconds: z.number().int().min(300).max(172800),
  })
  .strict();
export const prepareBuybackHookSchema = z.object({ ...action, hook: addressSchema }).strict();
export const prepareRouterTerminalSchema = z
  .object({ ...action, terminal: addressSchema })
  .strict();

export type RoutingInput = z.input<typeof routingSchema>;

/** Resolve only the bounded, recorded registry and gateway composition at the caller's snapshot. */
export async function resolveRouterTerminal(
  client: PublicClient,
  project: ProjectRef,
  entryTerminal: Address,
) {
  const path = [entryTerminal];
  let terminal = entryTerminal;
  if (isAddressEqual(terminal, v6Address('JBRouterTerminalRegistry', project.chainId))) {
    terminal = await client.readContract({
      address: terminal,
      abi: jbRouterTerminalRegistryAbi,
      functionName: 'terminalOf',
      args: [BigInt(project.projectId)],
    });
    path.push(terminal);
  }
  let router = terminal;
  let gateway: Address | null = null;
  if (
    deploymentAddresses('JBRouterTerminalGateway', project.chainId).some((address) =>
      isAddressEqual(address, terminal),
    )
  ) {
    gateway = terminal;
    const [forwardedRouter, directory] = await Promise.all([
      client.readContract({ address: gateway, abi: routerGatewayAbi, functionName: 'ROUTER' }),
      client.readContract({ address: gateway, abi: routerGatewayAbi, functionName: 'DIRECTORY' }),
    ]);
    if (
      typeof forwardedRouter !== 'string' ||
      !isAddress(forwardedRouter) ||
      typeof directory !== 'string' ||
      !isAddress(directory) ||
      !isAddressEqual(directory, v6Address('JBDirectory', project.chainId)) ||
      !deploymentAddresses('JBRouterTerminal', project.chainId).some((address) =>
        isAddressEqual(address, forwardedRouter),
      )
    )
      throw new DomainError(
        'UNSUPPORTED_ROUTER_GATEWAY',
        'The gateway does not reference a recorded router and the canonical V6 directory.',
      );
    router = forwardedRouter;
    path.push(router);
  }
  return { entryTerminal, terminal, gateway, router, path };
}
