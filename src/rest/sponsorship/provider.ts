import { isAddress, type Hex } from "viem";
import { RestError } from "../core.js";
import {
  RELAYR_LIMITS,
  RELAYR_MAINNET_CHAINS,
  RELAYR_TESTNET_CHAINS,
  RELAYR_NATIVE_TOKEN,
  RELAYR_ORIGIN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_SELECTOR,
} from "./constants.js";
import type { RelayrEntry, RelayrIndependentEntry, RelayrPayment, RelayrQuote } from "./types.js";
import {
  assertSignal,
  decimal,
  digest,
  fail,
  hash,
  object,
  quantity,
  same,
  scrub,
  uuid,
} from "./validation.js";

export type RelayrResponseDetails = { status: number; body: string; complete: boolean; truncated: boolean };
/** Operator diagnostics are deliberately absent from ordinary error serialization. */
export class RelayrResponseError extends RestError {
  #responseDetails: RelayrResponseDetails;
  constructor(error: RestError, details: RelayrResponseDetails) {
    super(error.status, error.code, error.message);
    this.#responseDetails = Object.freeze({ ...details });
  }
  get responseDetails(): RelayrResponseDetails { return this.#responseDetails; }
}

/** Fixed provider origin; callers cannot supply URLs, headers, redirects or credentials. */
export class RelayrProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 45_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000)
      fail("INVALID_SPONSORSHIP_POLICY", "Invalid provider timeout.", 500);
  }
  async create(entries: (RelayrEntry | RelayrIndependentEntry)[], signal?: AbortSignal): Promise<unknown> {
    return this.createWithMode(entries, "MultiChain", signal);
  }
  /** Operator-only independent contract deployments have no forwarding nonce dependencies. */
  async createIndependent(entries: RelayrIndependentEntry[], signal?: AbortSignal): Promise<unknown> {
    assertIndependentEntries(entries);
    return this.createWithMode(entries, "Disabled", signal);
  }
  private async createWithMode(entries: (RelayrEntry | RelayrIndependentEntry)[], mode: "MultiChain" | "Disabled", signal?: AbortSignal): Promise<unknown> {
    return this.json(
      "/v1/bundle/prepaid",
      {
        method: "POST",
        body: JSON.stringify({
          transactions: entries,
          virtual_nonce_mode: mode,
        }),
      },
      signal,
    );
  }
  async status(bundleUuid: string, signal?: AbortSignal): Promise<unknown> {
    if (!uuid(bundleUuid))
      fail("INVALID_BUNDLE_ID", "Expected a canonical bundle UUID.", 400);
    return this.json(`/v1/bundle/${bundleUuid}`, { method: "GET" }, signal);
  }
  private async json(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertSignal(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [];
    let complete = false, truncated = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new RestError(
            504,
            "RELAYR_TIMEOUT",
            "The execution service did not answer before the deadline. A submitted bundle may exist.",
          ),
        );
        controller.abort();
      }, this.timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            new RestError(
              499,
              "RELAYR_CANCELLED",
              "The Relayr request was interrupted. A submitted bundle may exist.",
            ),
          ),
        { once: true },
      );
    });
    const work = (async () => {
      response = await this.fetcher(`${RELAYR_ORIGIN}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        assertSignal(controller.signal);
      }
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d{1,10}$/.test(length) ||
          Number(length) > RELAYR_LIMITS.maximumBytes)
      ) {
        truncated = true;
        fail(
          "RELAYR_RESPONSE_LIMIT",
          "The execution service response exceeds the byte limit.",
          502,
        );
      }
      if (!response.body && !response.ok) {
        complete = true;
        fail("RELAYR_UNAVAILABLE", "The execution service rejected the request.", 502);
      }
      if (!response.body)
        fail(
          "RELAYR_INVALID_RESPONSE",
          "The execution service returned no JSON response body.",
          502,
        );
      reader = response.body.getReader();
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { complete = true; break; }
        bytes += chunk.value.byteLength;
        if (bytes > RELAYR_LIMITS.maximumBytes) {
          chunks.push(chunk.value.slice(0, Math.max(0, RELAYR_LIMITS.maximumBytes - (bytes - chunk.value.byteLength))));
          truncated = true;
          fail(
            "RELAYR_RESPONSE_LIMIT",
            "The execution service response exceeds the byte limit.",
            502,
          );
        }
        chunks.push(chunk.value);
      }
      if (!response.ok)
        fail("RELAYR_UNAVAILABLE", "The execution service rejected or could not answer the request.", 502);
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        return fail(
          "RELAYR_INVALID_RESPONSE",
          "The execution service returned invalid JSON.",
          502,
        );
      }
    })();
    try {
      return await Promise.race([work, deadline, cancelled]);
    } catch (error) {
      const failure = error instanceof RestError ? error : new RestError(502, "RELAYR_UNAVAILABLE",
        "The execution service could not be reached. A submitted bundle may exist.");
      if (response) throw new RelayrResponseError(failure, {
        status: response.status, body: Buffer.concat(chunks).toString('utf8'), complete, truncated,
      });
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (response) void response.body?.cancel().catch(() => {});
    }
  }
}

function deadlineSeconds(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,12})$/.test(value))
    return BigInt(value);
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0)
      return BigInt(Math.floor(parsed / 1000));
  }
  return fail(
    "RELAYR_INVALID_QUOTE",
    "The execution service returned an invalid payment deadline.",
    502,
  );
}
export function parsePayment(
  value: unknown,
  bundleUuid: string,
  now: number,
  maximumValue: bigint,
): RelayrPayment {
  const payment = parsePaymentBinding(value, bundleUuid);
  assertPaymentEligible(payment, now, maximumValue);
  return payment;
}
function parsePaymentBinding(
  value: unknown,
  bundleUuid: string,
  paymentChains: readonly number[] = RELAYR_MAINNET_CHAINS,
): RelayrPayment {
  if (
    !object(value) ||
    typeof value.chain !== "number" ||
    !paymentChains.some((chain) => chain === value.chain) ||
    !isAddress(String(value.target)) ||
    !same(String(value.target), RELAYR_PAYMENT_ADDRESS) ||
    !isAddress(String(value.token)) ||
    !same(String(value.token), RELAYR_NATIVE_TOKEN)
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "The execution service returned an unsupported payment chain, contract or token.",
      502,
    );
  let amount: bigint;
  try {
    amount = providerUint256(value.amount);
  } catch {
    return fail(
      "RELAYR_INVALID_QUOTE",
      "The execution service returned an invalid funding amount.",
      502,
    );
  }
  const data = value.calldata;
  if (
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{136}$/.test(data) ||
    data.slice(0, 10).toLowerCase() !== RELAYR_PAYMENT_SELECTOR ||
    data.slice(10, 74).toLowerCase() !==
      `${bundleUuid.replaceAll("-", "")}${"0".repeat(32)}`
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "Payment calldata is not bound to this bundle.",
      502,
    );
  const deadline = BigInt(`0x${data.slice(74)}`);
  if (
    deadline >= 1n << 40n ||
    deadline !== deadlineSeconds(value.payment_deadline)
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "Payment calldata and quote deadlines do not match.",
      502,
    );
  return {
    chainId: value.chain,
    to: RELAYR_PAYMENT_ADDRESS,
    data: data.toLowerCase() as Hex,
    value: amount.toString(),
    deadline: deadline.toString(),
  };
}
/** Relayr serializes U256 as hex; internal request/commitment values remain canonical decimal. */
function providerUint256(value: unknown): bigint {
  return typeof value === 'string' && value.startsWith('0x')
    ? quantity(value, 'provider uint256') : decimal(value, 'provider uint256');
}
function sameProviderValue(value: unknown, expected: string): boolean {
  try { return providerUint256(value) === decimal(expected, 'expected value'); }
  catch { return false; }
}

export function parseQuote(
  value: unknown,
  entries: RelayrEntry[],
  now: number,
  maximumValue: bigint,
): RelayrQuote {
  const quote = parseQuoteBinding(value, entries, now);
  for (const payment of quote.payments)
    assertPaymentEligible(payment, now, maximumValue);
  return quote;
}
/** Preserve a structurally authenticated recovery identity before funding policy or RPC checks. */
export function parseQuoteBinding(
  value: unknown,
  entries: RelayrEntry[],
  now: number,
): RelayrQuote {
  return quoteBinding(value, entries, now, RELAYR_MAINNET_CHAINS);
}
/** Operator-only: retain the clients' same-family payment policy without expanding app sponsorship. */
export function parseIndependentQuoteBinding(value: unknown, entries: RelayrIndependentEntry[], now: number): RelayrQuote<RelayrIndependentEntry> {
  assertIndependentEntries(entries);
  return quoteBinding(value, entries, now, paymentFamily(entries));
}
/** Center-sponsored deployments pay from the one family every destination belongs to. */
export function parseFamilyQuote<Entry extends RelayrEntry | RelayrIndependentEntry>(
  value: unknown,
  entries: Entry[],
  now: number,
  maximumValue: bigint,
): RelayrQuote<Entry> {
  const quote = quoteBinding(value, entries, now, paymentFamily(entries));
  for (const payment of quote.payments) assertPaymentEligible(payment, now, maximumValue);
  return quote;
}
function paymentFamily(entries: readonly (RelayrEntry | RelayrIndependentEntry)[]): readonly number[] {
  const chains = [RELAYR_MAINNET_CHAINS, RELAYR_TESTNET_CHAINS].find(family =>
    entries.length > 0 && entries.every(entry => family.some(chain => chain === entry.chain)));
  if (!chains) fail("RELAYR_INVALID_QUOTE", "Choose destinations from one supported network family.", 502);
  return chains;
}
function assertIndependentEntries(entries: readonly RelayrIndependentEntry[]): void {
  if (entries.some(entry => Object.hasOwn(entry, 'virtual_nonce')))
    fail('RELAYR_INVALID_REQUEST', 'Disabled ordering forbids a virtual nonce.', 400);
}
function quoteBinding<Entry extends RelayrEntry | RelayrIndependentEntry>(value: unknown, entries: Entry[], now: number, paymentChains: readonly number[]): RelayrQuote<Entry> {
  if (
    !object(value) ||
    !uuid(value.bundle_uuid) ||
    !Array.isArray(value.payment_info) ||
    value.payment_info.length < 1 ||
    value.payment_info.length > 4
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "The execution service did not return a bounded prepaid bundle.",
      502,
    );
  const ids = value.tx_uuids ?? value.txn_uuids;
  if (
    value.tx_uuids !== undefined &&
    value.txn_uuids !== undefined &&
    JSON.stringify(value.tx_uuids) !== JSON.stringify(value.txn_uuids)
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "The execution service returned conflicting transaction identifiers.",
      502,
    );
  if (
    !Array.isArray(ids) ||
    ids.length !== entries.length ||
    !ids.every(uuid) ||
    new Set(ids).size !== ids.length
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "The execution service must bind each exact transaction to a unique identifier.",
      502,
    );
  const payments = value.payment_info.map((payment) =>
    parsePaymentBinding(payment, value.bundle_uuid as string, paymentChains),
  );
  if (
    new Set(payments.map((payment) => payment.chainId)).size !== payments.length
  )
    fail(
      "RELAYR_INVALID_QUOTE",
      "The execution service returned duplicate payment chains.",
      502,
    );
  const quote = {
    bundleUuid: value.bundle_uuid,
    entries: entries.map((entry, i) => ({ txUuid: ids[i] as string, entry })),
    payments,
    observedAt: now,
  };
  return { ...quote, commitment: digest(quote) };
}
export function assertPaymentEligible(
  payment: RelayrPayment,
  now: number,
  maximumValue: bigint,
): void {
  if (BigInt(payment.value) > maximumValue)
    fail(
      "RELAYR_FUNDING_LIMIT",
      "The quote exceeds the configured maximum native funding amount.",
    );
  if (BigInt(payment.deadline) <= BigInt(Math.floor(now / 1000) + 30))
    fail(
      "RELAYR_QUOTE_EXPIRED",
      "The payment quote expires too soon to review and fund safely.",
      409,
    );
}
export function parseStatus(
  value: unknown,
  quote: RelayrQuote<RelayrEntry | RelayrIndependentEntry>,
): { step: number; providerState: string; hash?: Hex }[] {
  return statusBinding(value, quote);
}
/** POST UUID order is not request order. Establish the bijection from the GET echo,
 * authenticating the returned UUID set and every requested field before committing it. */
export function bindIndependentQuoteStatus(value: unknown, provisional: RelayrQuote<RelayrIndependentEntry>): RelayrQuote<RelayrIndependentEntry> {
  return withStatusDetail(value, () => boundIndependentQuoteStatus(value, provisional));
}
function boundIndependentQuoteStatus(value: unknown, provisional: RelayrQuote<RelayrIndependentEntry>): RelayrQuote<RelayrIndependentEntry> {
  assertIndependentEntries(provisional.entries.map(item => item.entry));
  if (!object(value) || value.bundle_uuid !== provisional.bundleUuid || !Array.isArray(value.transactions)
    || value.transactions.length !== provisional.entries.length)
    fail('RELAYR_INVALID_STATUS', 'The stored bundle does not echo every requested call.', 502);
  const transactions = value.transactions;
  const ids = new Set(provisional.entries.map(item => item.txUuid)), used = new Set<string>();
  const entries = provisional.entries.map(({ entry }) => {
    const matches = transactions.filter((item: unknown) => object(item) && object(item.request)
      && item.request.chain === entry.chain && typeof item.request.target === 'string' && same(item.request.target, entry.target)
      && typeof item.request.data === 'string' && same(item.request.data, entry.data)
      && sameProviderValue(item.request.value, entry.value) && item.request.virtual_nonce == null);
    const item: unknown = matches[0];
    if (matches.length !== 1 || !object(item) || !uuid(item.tx_uuid) || !ids.has(item.tx_uuid) || used.has(item.tx_uuid))
      fail('RELAYR_INVALID_STATUS', 'Provider identifiers do not uniquely bind the exact requested calls.', 502);
    used.add(item.tx_uuid);
    return { txUuid: item.tx_uuid, entry };
  });
  const { commitment: _previous, ...metadata } = provisional;
  const bound = { ...metadata, entries };
  const quote = { ...bound, commitment: digest(bound) };
  parseIndependentStatus(value, quote);
  return quote;
}
/** Disabled mode has no nonce; Relayr may represent an absent optional field as null. */
export function parseIndependentStatus(value: unknown, quote: RelayrQuote<RelayrIndependentEntry>) {
  assertIndependentEntries(quote.entries.map(item => item.entry));
  return statusBinding(value, quote);
}
const DETAIL_LIMIT = 2048;
/** A rejected status is the one body an operator must see to know which check fired;
 * it reaches the log scrubbed of URLs and payload bytes, never a client response. */
function withStatusDetail<T>(value: unknown, bind: () => T): T {
  try {
    return bind();
  } catch (error) {
    if (!(error instanceof RestError) || error.code !== "RELAYR_INVALID_STATUS") throw error;
    if (typeof error.details === "string") throw error;
    let body: string;
    try {
      body = JSON.stringify(value) ?? String(value);
    } catch {
      body = "the status body could not be serialized";
    }
    throw new RestError(error.status, error.code, error.message,
      scrub(`${error.message} ${body}`, DETAIL_LIMIT));
  }
}
function statusBinding(value: unknown, quote: RelayrQuote<RelayrEntry | RelayrIndependentEntry>):
  { step: number; providerState: string; hash?: Hex }[] {
  return withStatusDetail(value, () => boundStatus(value, quote));
}
function boundStatus(value: unknown, quote: RelayrQuote<RelayrEntry | RelayrIndependentEntry>):
  { step: number; providerState: string; hash?: Hex }[] {
  if (
    !object(value) ||
    value.bundle_uuid !== quote.bundleUuid ||
    !Array.isArray(value.transactions) ||
    value.transactions.length !== quote.entries.length
  )
    fail(
      "RELAYR_INVALID_STATUS",
      "The execution service status does not match the stored bundle.",
      502,
    );
  const observed = new Set<string>();
  return value.transactions.map((item) => {
    if (
      !object(item) ||
      !uuid(item.tx_uuid) ||
      observed.has(item.tx_uuid) ||
      !object(item.request) ||
      (item.status != null && !object(item.status))
    )
      fail(
        "RELAYR_INVALID_STATUS",
        "The execution service returned malformed or duplicate transaction records.",
        502,
      );
    observed.add(item.tx_uuid);
    // A transaction the service has not started yet carries no status record: it is
    // pending, with no hash, and only the request binding is authenticated.
    const status = object(item.status) ? item.status : null;
    const index = quote.entries.findIndex(
      (entry) => entry.txUuid === item.tx_uuid,
    );
    const expected = quote.entries[index]?.entry;
    const changed = !expected ? "tx_uuid"
      : item.request.chain !== expected.chain ? "chain"
      : typeof item.request.target !== "string" || !same(item.request.target, expected.target) ? "target"
      : typeof item.request.data !== "string" || !same(item.request.data, expected.data) ? "data"
      : !sameProviderValue(item.request.value, expected.value) ? "value"
      // An entry with no nonce was sent unordered; the provider may echo that as null.
      : (expected.virtual_nonce === undefined
          ? item.request.virtual_nonce != null
          : item.request.virtual_nonce !== expected.virtual_nonce) ? "virtual_nonce"
      : status !== null && (typeof status.state !== "string" || status.state.length > 64) ? "status.state"
      : null;
    if (changed !== null)
      fail(
        "RELAYR_INVALID_STATUS",
        `Provider status changed the stored transaction binding (${changed}).`,
        502,
      );
    const details = status !== null && object(status.data) ? status.data : {};
    const nested = object(details.transaction)
      ? details.transaction.hash
      : undefined;
    if (
      details.hash !== undefined &&
      nested !== undefined &&
      details.hash !== nested
    )
      fail(
        "RELAYR_INVALID_STATUS",
        "The execution service returned conflicting destination hashes.",
        502,
      );
    const txHash = details.hash ?? nested;
    if (txHash !== undefined && !hash(txHash))
      fail(
        "RELAYR_INVALID_STATUS",
        "The execution service returned an invalid destination hash.",
        502,
      );
    return {
      step: index,
      providerState: status === null ? "Pending" : (status.state as string),
      ...(txHash === undefined ? {} : { hash: txHash as Hex }),
    };
  });
}
