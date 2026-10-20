import { z } from 'zod';
import { getAddress, isAddress } from 'viem';
import { assertUnambiguousJson } from './json.js';

export const chainIdSchema = z.union([
  z.literal(1),
  z.literal(10),
  z.literal(8453),
  z.literal(42161),
  z.literal(11155111),
  z.literal(11155420),
  z.literal(84532),
  z.literal(421614),
]);
const UINT_PATTERN = '^(0|[1-9][0-9]*)$';
const SEND_STRINGS =
  'Send this value as a base-10 integer string. JSON numbers are accepted only for bounded fields (percents, durations, timestamps, chain IDs, small counts); amounts and IDs must be strings.';
const decimalUintSchema = z
  .string({ error: (issue) => (issue.input === undefined ? undefined : SEND_STRINGS) })
  .meta({ pattern: UINT_PATTERN, maxLength: 78 })
  .regex(/^(0|[1-9][0-9]*)$/, {
    message: 'Use a base-10 integer string, without decimals or exponents.',
    abort: true,
  })
  .max(78, { abort: true })
  .refine(
    (value) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) < 1n << 256n,
    { message: 'Must fit uint256.', abort: true },
  );
/**
 * A uint256 as a base-10 integer string. Amounts, weights and wei take only this: JSON parsing has already
 * rounded a number before any check could see its digits.
 */
export const uintSchema = decimalUintSchema;
/**
 * Only for fields bounded well inside 2^53 (percents, durations, timestamps, chain IDs, small counts), through
 * rulesets.ts uint(): a base-10 string, or a safe non-negative integer JSON number normalized to its string.
 * Amounts and identifiers with wider ranges take strings only.
 */
export const smallUintSchema = z
  .union([z.number(), z.string().meta({ pattern: UINT_PATTERN, maxLength: 78 })])
  .transform((value, ctx) => {
    if (typeof value === 'string') return value;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    ctx.addIssue({
      code: 'custom',
      message:
        'A JSON number must be a non-negative integer no larger than 9007199254740991 (2^53 - 1). Send larger or exact values as a base-10 string.',
    });
    return z.NEVER;
  })
  .pipe(decimalUintSchema);
const positive = (value: string) => /^[1-9][0-9]*$/.test(value);
export const positiveUintSchema = uintSchema.refine(positive, 'Must be positive.');
export const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), 'Use a valid EVM address.')
  .transform((value) => getAddress(value));
export const hexSchema = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})*$/)
  .max(262146)
  .transform((value) => value as `0x${string}`);
export const hashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as `0x${string}`);
export const projectSchema = z
  .object({
    chainId: chainIdSchema,
    projectId: positiveUintSchema,
    version: z.literal(6).default(6),
  })
  .strict();
export const slippageSchema = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .default(100)
  .describe('Slippage in basis points, 0–1000. Default 100 (1%).');
export const pageSchema = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1024).optional(),
};
export const jsonObjectSchema = z.preprocess(
  (value, ctx) => {
    try {
      assertUnambiguousJson(value);
      return value;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'JSON must be bounded and must not contain reserved object keys (__proto__, constructor, prototype). No altered commitment will be produced.',
      });
      return z.NEVER;
    }
  },
  z.record(z.string(), z.json()),
);

export const skipSplitsSchema = z
  .boolean()
  .optional()
  .describe(
    "Buyback 1.4 only. Unset means on wherever the project's buyback hook is 1.4 and no metadata is given, as the apps pay: the hook buys from the pool when that beats the payer's share of a mint, and the tokens it buys go to the beneficiary without the reserved split (they already exist, so nothing is issued for them and the split gets none). Minting still pays the split. The default minimum is then the SDK's (prepareUserPay): with a pool quote, the beneficiary's part of the floored quote, which the hook also enforces. Pass false when the payment should honor the project's splits, such as routing fees or revenue into a project. Where it cannot apply (no buyback hook, hook 1.0 or 1.1.1, the caller's own metadata) unset means off, and an explicit true is refused. The quote's skipSplits says which applied and why.",
  );
