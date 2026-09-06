import { z } from 'zod';
import { addressSchema, projectSchema } from './schemas.js';

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
        'Registration at 172800 stores the contract default of 1800 seconds. Use the TWAP update tool afterward for an explicit 172800-second window.',
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
