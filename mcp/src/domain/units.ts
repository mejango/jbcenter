import {
  MAX_CASH_OUT_TAX_RATE,
  MAX_RESERVED_PERCENT,
  MAX_WEIGHT_CUT_PERCENT,
  NATIVE_TOKEN,
  SPLITS_TOTAL_PERCENT,
} from '@bananapus/nana-sdk-core';
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  DISCOUNT_DENOMINATOR,
  JBPermissionIdsV6,
  MAX_FEE,
  MAX_PREPAID_FEE_PERCENT,
  MIN_PREPAID_FEE_PERCENT,
  NATIVE_TOKEN_CURRENCY_ID,
} from '@bananapus/nana-sdk-core/v6';

const n = (value: number | bigint) => Number(value).toLocaleString('en-US');
const native = `native ETH is ${NATIVE_TOKEN}`;
const currencyIds = `uint32(uint160(token)) for a token (${native}, currency ${NATIVE_TOKEN_CURRENCY_ID}), or ${BASE_CURRENCY_ETH} = ETH and ${BASE_CURRENCY_USD} = USD`;
const currencyId = `JB currency ID: ${currencyIds}.`;

/** Units for scaled inputs, from the V6 contract constants the SDK mirrors. One home for tool descriptions. */
export const UNITS = {
  reservedPercent: `Share of new tokens reserved for splits, out of ${n(MAX_RESERVED_PERCENT)}. 2500 = 25%.`,
  cashOutTaxRate: `Cash-out tax out of ${n(MAX_CASH_OUT_TAX_RATE)}. 0 = no tax; ${n(MAX_CASH_OUT_TAX_RATE)} = cash outs return nothing.`,
  revnetCashOutTaxRate: `Cash-out tax out of ${n(MAX_CASH_OUT_TAX_RATE)}, at most 9,999. 0 = no tax.`,
  revnetSplitPercent: `Share of new tokens sent to this stage's splits, out of ${n(MAX_RESERVED_PERCENT)}. 2000 = 20%.`,
  splitPercent: `Share of the split group, out of ${n(SPLITS_TOTAL_PERCENT)}. 500,000,000 = 50%.`,
  tierSplitPercent: `Share of the tier price sent to the tier's splits, out of ${n(SPLITS_TOTAL_PERCENT)}.`,
  maximumSplitPercent: `Largest tier split a poster may set, out of ${n(SPLITS_TOTAL_PERCENT)}.`,
  weightCutPercent: `Issuance cut applied each cycle, out of ${n(MAX_WEIGHT_CUT_PERCENT)}. 100,000,000 = 10%.`,
  issuanceCutPercent: `Issuance cut applied every issuanceCutFrequency, out of ${n(MAX_WEIGHT_CUT_PERCENT)}. 0 = no cut.`,
  issuanceCutFrequency: 'Seconds between issuance cuts.',
  weight:
    'Tokens issued per one unit of baseCurrency, with 18 decimals: 1000000000000000000000 = 1,000 tokens. 0 means zero issuance; 1 inherits decayed weight when a prior ruleset exists.',
  initialIssuance:
    'Tokens issued per one unit of baseCurrency at stage start, with 18 decimals: 1000000000000000000000 = 1,000 tokens.',
  baseCurrency: `Currency that issuance is priced in: ${BASE_CURRENCY_ETH} = ETH, ${BASE_CURRENCY_USD} = USD. Use ${BASE_CURRENCY_ETH} for ETH, not ${NATIVE_TOKEN_CURRENCY_ID} (native ETH's accounting currency). A token's own currency, uint32(uint160(token)), applies only when payments come in that token or JBPrices has a feed for it.`,
  extraMetadata:
    'Ruleset metadata bits for hooks (uint16, lower 14 bits kept, at most 16,383). Bit 2 (value 4): the operator may deploy new suckers during this stage; every stage needs it when suckers are configured. Bits 0 (1) and 1 (2): the NFT hook pauses transfers of pausable tiers, and pending reserve mints. 4 is usual for a multi-chain revnet, 0 for one chain.',
  scopeCashOutsToLocalBalances:
    "false: cash outs count every chain's supply and surplus (through the suckers). true: only this chain's.",
  currency: currencyId,
  payoutCurrency: `Currency that amount is in; it must match a payout limit currency. ${currencyId}`,
  accountingCurrency: `Usually uint32(uint160(token)); ${native}, currency ${NATIVE_TOKEN_CURRENCY_ID}.`,
  decimals: 'Token decimals. Native ETH uses 18.',
  token: `Token address; ${native}.`,
  groupId: `Payout splits: uint256(uint160(token)) as a decimal string (${native}, group ${NATIVE_TOKEN_CURRENCY_ID}). Reserved token splits: 1.`,
  tierPrice: 'Tier price in the tiers currency, with the tiers decimals.',
  discountPercent: `Tier price discount, out of ${n(DISCOUNT_DENOMINATOR)}. ${n(DISCOUNT_DENOMINATOR)} = free.`,
  prepaidFeePercent: `Fee prepaid at borrow time, out of ${n(MAX_FEE)}. Allowed ${n(MIN_PREPAID_FEE_PERCENT)} (${Number(MIN_PREPAID_FEE_PERCENT) / 10}%) to ${n(MAX_PREPAID_FEE_PERCENT)} (${Number(MAX_PREPAID_FEE_PERCENT) / 10}%).`,
  permissionIds: `JBPermissionIds: ${Object.entries(JBPermissionIdsV6)
    .map(([name, id]) => `${id} ${name}`)
    .join(', ')}.`,
} as const;
