import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  RelayrProvider,
  bindIndependentQuoteStatus,
  RelayrResponseError,
  parseFamilyQuote,
  parseIndependentQuoteBinding,
  parseIndependentStatus,
  parsePayment,
  parseQuote,
  parseStatus,
} from "../src/rest/sponsorship/provider.js";
import {
  RELAYR_LIMITS,
  RELAYR_MAINNET_CHAINS,
  RELAYR_NATIVE_TOKEN,
  RELAYR_ORIGIN,
  RELAYR_PAYMENT_ADDRESS,
} from "../src/rest/sponsorship/constants.js";
import type {
  RelayrEntry,
  RelayrQuote,
} from "../src/rest/sponsorship/types.js";

const NOW = Date.parse("2026-09-07T00:00:00Z");
const DEADLINE = BigInt(NOW / 1000 + 300);
const MAXIMUM_VALUE = 10n ** 18n;
const BUNDLE = "a0a555ff-4444-4111-aaaa-333333333333";
const TX_IDS = [
  "b0a555ff-4444-4111-aaaa-333333333333",
  "c0a555ff-4444-4111-aaaa-333333333333",
];
const TARGET = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const PRIVATE_ERROR =
  "private-provider-body https://provider.example/secret-token";

function entries(): RelayrEntry[] {
  return [
    {
      chain: 8453,
      target: TARGET,
      data: "0x12345678",
      value: "0",
      virtual_nonce: 0,
    },
    {
      chain: 10,
      target: TARGET,
      data: "0xabcdef12",
      value: "12",
      virtual_nonce: 0,
    },
  ];
}

function independentEntries() { return entries().map(({ virtual_nonce, ...entry }) => entry); }

function paymentData(bundle = BUNDLE, deadline = DEADLINE): Hex {
  // ABI-encode the independently reviewed bytes16 and uint40 argument layout.
  // uint256 permits constructing out-of-range negative test vectors too.
  const args = encodeAbiParameters(
    [{ type: "bytes16" }, { type: "uint256" }],
    [`0x${bundle.replaceAll("-", "")}`, deadline],
  );
  return `0x103903a7${args.slice(2)}`;
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    chain: 8453,
    target: RELAYR_PAYMENT_ADDRESS,
    token: RELAYR_NATIVE_TOKEN,
    amount: "9007199254740993",
    calldata: paymentData(),
    payment_deadline: DEADLINE.toString(),
    ...overrides,
  };
}

function quoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    bundle_uuid: BUNDLE,
    tx_uuids: [...TX_IDS],
    payment_info: [payment()],
    ...overrides,
  };
}

it('accepts testnet payments only for the operator same-family parser; ordinary app sponsorship stays mainnet-only', () => {
  const testEntries = independentEntries().map(entry => ({ ...entry, chain: 84532 }));
  const response = quoteResponse({ payment_info: [payment({ chain: 84532 })] });
  expect(parseIndependentQuoteBinding(response, testEntries, NOW).payments[0]!.chainId).toBe(84532);
  expect(() => parseQuote(response, entries().map(entry => ({ ...entry, chain: 84532 })), NOW, MAXIMUM_VALUE)).toThrow();
  expect(() => parseIndependentQuoteBinding(response, independentEntries(), NOW)).toThrow();
  expect(() => parseIndependentQuoteBinding(response, [independentEntries()[0]!, testEntries[1]!], NOW)).toThrow();
  expect(() => parseIndependentQuoteBinding(response, [], NOW)).toThrow();
});

it('pays sponsored bundles from the one family every destination belongs to', () => {
  const testEntries = entries().map(entry => ({ ...entry, chain: 84532 }));
  const testResponse = quoteResponse({ payment_info: [payment({ chain: 84532 })] });
  expect(parseFamilyQuote(quoteResponse(), entries(), NOW, MAXIMUM_VALUE).payments[0]!.chainId).toBe(8453);
  expect(parseFamilyQuote(testResponse, testEntries, NOW, MAXIMUM_VALUE).payments[0]!.chainId).toBe(84532);
  expect(() => parseFamilyQuote(testResponse, [entries()[0]!, testEntries[1]!], NOW, MAXIMUM_VALUE)).toThrow();
  expect(() => parseFamilyQuote(quoteResponse(), [], NOW, MAXIMUM_VALUE)).toThrow();
  expect(() => parseFamilyQuote(testResponse, testEntries, NOW, 1n)).toThrow(/maximum native funding/);
});

function quote(): RelayrQuote {
  return parseQuote(quoteResponse(), entries(), NOW, MAXIMUM_VALUE);
}

function statusResponse() {
  return {
    bundle_uuid: BUNDLE,
    transactions: entries().map((entry, index) => ({
      tx_uuid: TX_IDS[index]!,
      request: { ...entry },
      status: { state: "Pending", data: {} as Record<string, unknown> },
    })),
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Relayr quote commitments and payment validation", () => {
  it("preserves exact funding amounts and ABI-bound bundle/deadline on every supported chain", () => {
    for (const chain of RELAYR_MAINNET_CHAINS) {
      expect(
        parsePayment(payment({ chain }), BUNDLE, NOW, MAXIMUM_VALUE),
      ).toEqual({
        chainId: chain,
        to: RELAYR_PAYMENT_ADDRESS,
        data: paymentData(),
        value: "9007199254740993",
        deadline: DEADLINE.toString(),
      });
    }
    expect(
      parsePayment(payment({ amount: "0" }), BUNDLE, NOW, MAXIMUM_VALUE).value,
    ).toBe("0");
  });

  it('normalizes bounded provider hex amounts losslessly, including values above JS safe integers', () => {
    for (const amount of ['0', '9007199254740993', ((1n << 256n) - 1n).toString()]) {
      const input = `0x${BigInt(amount).toString(16)}`;
      expect(parsePayment(payment({ amount: input }), BUNDLE, NOW, (1n << 256n) - 1n).value).toBe(amount);
    }
    expect(() => parsePayment(payment({ amount: '0x20000000000001' }), BUNDLE, NOW, 9007199254740992n))
      .toThrowError(expect.objectContaining({ code: 'RELAYR_FUNDING_LIMIT' }));
  });

  it('binds unordered provider IDs using every exact independent call, then verifies status normally', () => {
    const original = parseIndependentQuoteBinding(quoteResponse({ tx_uuids: [...TX_IDS].reverse() }), independentEntries(), NOW);
    const status = statusResponse();
    for (const item of status.transactions) Object.assign(item.request, { value: `0x${BigInt(item.request.value).toString(16)}`, virtual_nonce: null });
    status.transactions.reverse();
    const bound = bindIndependentQuoteStatus(status, original);
    expect(bound.entries.map(item => item.txUuid)).toEqual(TX_IDS);
    expect(bound.entries.map(item => item.entry)).toEqual(independentEntries());
    expect(bound.commitment).not.toBe(original.commitment);
    expect(parseIndependentStatus(status, bound).map(item => item.step)).toEqual([1, 0]);
    expect(original.entries.map(item => item.txUuid)).toEqual([...TX_IDS].reverse());
    for (const field of ['chain', 'target', 'data', 'value', 'virtual_nonce'] as const) {
      const changed = structuredClone(status);
      Object.assign(changed.transactions[0]!.request, { [field]: field === 'virtual_nonce' ? 0 : field === 'chain' ? 1 : field === 'value' ? '0xd' : '0x00' });
      expect(() => bindIndependentQuoteStatus(changed, original)).toThrow();
    }
    for (const invalid of ['0x00', '0Xc', '0x', '-1', '1e2', null, 12, `0x1${'0'.repeat(64)}`]) {
      const changed = structuredClone(status);
      Object.assign(changed.transactions[0]!.request, { value: invalid });
      expect(() => bindIndependentQuoteStatus(changed, original)).toThrow();
    }
    const unknown = structuredClone(status); unknown.transactions[0]!.tx_uuid = BUNDLE;
    expect(() => bindIndependentQuoteStatus(unknown, original)).toThrow();
    const duplicate = structuredClone(status); duplicate.transactions[1] = structuredClone(duplicate.transactions[0]!);
    expect(() => bindIndependentQuoteStatus(duplicate, original)).toThrow();
    const repeatedCall = structuredClone(status); repeatedCall.transactions[1]!.request = structuredClone(repeatedCall.transactions[0]!.request);
    expect(() => bindIndependentQuoteStatus(repeatedCall, original)).toThrow();
    expect(() => bindIndependentQuoteStatus({ ...status, bundle_uuid: TX_IDS[0] }, original)).toThrow();
    expect(() => bindIndependentQuoteStatus({ ...status, transactions: status.transactions.slice(1) }, original)).toThrow();
  });

  it('accepts exact hexadecimal status values while preserving strict ordered nonces and value equality', () => {
    const status = statusResponse();
    for (const item of status.transactions) item.request.value = `0x${BigInt(item.request.value).toString(16)}`;
    expect(parseStatus(status, quote())).toHaveLength(2);
    status.transactions[1]!.request.value = '0xd';
    expect(() => parseStatus(status, quote())).toThrow();
  });

  it.each([
    ["testnet chain", { chain: 84532 }],
    ["string chain", { chain: "8453" }],
    ["unknown chain", { chain: 999 }],
    ["foreign target", { target: TARGET }],
    ["malformed target", { target: "0x123" }],
    ["ERC-20 funding token", { token: TARGET }],
    ["missing funding token", { token: undefined }],
    ["numeric amount", { amount: 123 }],
    ["exponent amount", { amount: "1e18" }],
    ["noncanonical hex amount", { amount: "0x0123" }],
    ["hex overflow", { amount: `0x1${"0".repeat(64)}` }],
    ["empty hex amount", { amount: "0x" }],
    ["negative amount", { amount: "-1" }],
    ["leading zero amount", { amount: "01" }],
    ["uint256 overflow", { amount: (1n << 256n).toString() }],
    ["missing calldata", { calldata: undefined }],
    ["wrong selector", { calldata: `0xffffffff${paymentData().slice(10)}` }],
    ["wrong bundle", { calldata: paymentData(TX_IDS[0]) }],
    ["trailing calldata", { calldata: `${paymentData()}00` }],
    ["short calldata", { calldata: paymentData().slice(0, -2) }],
    ["non-hex calldata", { calldata: `${paymentData().slice(0, -1)}z` }],
    [
      "nonzero bytes16 padding",
      { calldata: `${paymentData().slice(0, 73)}1${paymentData().slice(74)}` },
    ],
    ["missing deadline", { payment_deadline: undefined }],
    ["fractional deadline", { payment_deadline: Number(DEADLINE) + 0.5 }],
    ["noncanonical deadline", { payment_deadline: `0${DEADLINE}` }],
    ["mismatched deadline", { payment_deadline: (DEADLINE + 1n).toString() }],
    [
      "uint40 overflow",
      {
        calldata: paymentData(BUNDLE, 1n << 40n),
        payment_deadline: (1n << 40n).toString(),
      },
    ],
  ])("rejects %s before exposing a funding transaction", (_name, overrides) => {
    expect(() =>
      parsePayment(payment(overrides), BUNDLE, NOW, MAXIMUM_VALUE),
    ).toThrowError(
      expect.objectContaining({ code: "RELAYR_INVALID_QUOTE", status: 502 }),
    );
  });

  it("enforces the configured funding cap without rounding or silently reducing the payment", () => {
    expect(
      parsePayment(
        payment({ amount: MAXIMUM_VALUE.toString() }),
        BUNDLE,
        NOW,
        MAXIMUM_VALUE,
      ).value,
    ).toBe(MAXIMUM_VALUE.toString());
    expect(() =>
      parsePayment(
        payment({ amount: (MAXIMUM_VALUE + 1n).toString() }),
        BUNDLE,
        NOW,
        MAXIMUM_VALUE,
      ),
    ).toThrowError(expect.objectContaining({ code: "RELAYR_FUNDING_LIMIT" }));
  });

  it("accepts equivalent numeric/ISO deadlines and requires more than 30 seconds remaining", () => {
    for (const deadline of [
      Number(DEADLINE),
      DEADLINE.toString(),
      new Date(Number(DEADLINE) * 1000).toISOString(),
      "2026-09-06T21:05:00-03:00",
      "2026-09-07T00:05:00.960633325Z",
    ]) {
      expect(
        parsePayment(
          payment({ payment_deadline: deadline }),
          BUNDLE,
          NOW,
          MAXIMUM_VALUE,
        ).deadline,
      ).toBe(DEADLINE.toString());
    }
    for (const remaining of [-1, 0, 30]) {
      const deadline = BigInt(NOW / 1000 + remaining);
      expect(() =>
        parsePayment(
          payment({
            calldata: paymentData(BUNDLE, deadline),
            payment_deadline: deadline.toString(),
          }),
          BUNDLE,
          NOW,
          MAXIMUM_VALUE,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "RELAYR_QUOTE_EXPIRED", status: 409 }),
      );
    }
    const deadline = BigInt(NOW / 1000 + 31);
    expect(
      parsePayment(
        payment({
          calldata: paymentData(BUNDLE, deadline),
          payment_deadline: deadline.toString(),
        }),
        BUNDLE,
        NOW,
        MAXIMUM_VALUE,
      ).deadline,
    ).toBe(deadline.toString());
  });

  it("binds ordered exact entries and identifiers into a stable commitment", () => {
    const original = quote();
    expect(original.entries).toEqual(
      entries().map((entry, index) => ({ entry, txUuid: TX_IDS[index] })),
    );
    expect(original.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(quote().commitment).toBe(original.commitment);
    const changed = entries();
    changed[0]!.data = "0x12345679";
    expect(
      parseQuote(quoteResponse(), changed, NOW, MAXIMUM_VALUE).commitment,
    ).not.toBe(original.commitment);
    expect(
      parseQuote(
        quoteResponse({ tx_uuids: [...TX_IDS].reverse() }),
        entries(),
        NOW,
        MAXIMUM_VALUE,
      ).commitment,
    ).not.toBe(original.commitment);
    expect(
      parseQuote(
        quoteResponse({ tx_uuids: undefined, txn_uuids: TX_IDS }),
        entries(),
        NOW,
        MAXIMUM_VALUE,
      ),
    ).toEqual(original);
  });

  it.each([
    ["uppercase bundle UUID", { bundle_uuid: BUNDLE.toUpperCase() }],
    ["malformed bundle UUID", { bundle_uuid: "../v1/bundle/other" }],
    ["missing transaction IDs", { tx_uuids: undefined }],
    ["too few transaction IDs", { tx_uuids: TX_IDS.slice(0, 1) }],
    ["duplicate transaction IDs", { tx_uuids: [TX_IDS[0], TX_IDS[0]] }],
    ["malformed transaction ID", { tx_uuids: [TX_IDS[0], "arbitrary"] }],
    ["conflicting identifier fields", { txn_uuids: [...TX_IDS].reverse() }],
    ["empty payment choices", { payment_info: [] }],
    [
      "unbounded payment choices",
      { payment_info: Array.from({ length: 5 }, () => payment()) },
    ],
    ["duplicate payment chain", { payment_info: [payment(), payment()] }],
  ])("rejects a quote with %s", (_name, overrides) => {
    expect(() =>
      parseQuote(quoteResponse(overrides), entries(), NOW, MAXIMUM_VALUE),
    ).toThrowError(
      expect.objectContaining({ code: "RELAYR_INVALID_QUOTE", status: 502 }),
    );
  });

  it("accepts bounded distinct payment chains and identical legacy identifier aliases", () => {
    const result = parseQuote(
      quoteResponse({
        txn_uuids: TX_IDS,
        payment_info: [payment(), payment({ chain: 1 })],
      }),
      entries(),
      NOW,
      MAXIMUM_VALUE,
    );
    expect(result.payments.map(({ chainId }) => chainId)).toEqual([8453, 1]);
  });
});

describe("Relayr status is bound to stored exact entries", () => {
  it("maps reordered provider records back to steps and extracts only a consistent hash hint", () => {
    const response = statusResponse();
    response.transactions[0]!.status = {
      state: "Broadcast",
      data: { transaction: { hash: HASH }, hash: HASH },
    };
    response.transactions.reverse();
    expect(parseStatus(response, quote())).toEqual([
      { step: 1, providerState: "Pending" },
      { step: 0, providerState: "Broadcast", hash: HASH },
    ]);
  });

  it.each([
    ["chain", "1"],
    ["target", "0x2222222222222222222222222222222222222222"],
    ["data", "0x12345679"],
    ["value", 0],
    ["value", "00"],
    ["virtual_nonce", 1],
  ])("rejects a changed transaction %s binding", (field, value) => {
    const response = statusResponse();
    const request: Record<string, unknown> = {
      ...response.transactions[0]!.request,
      [field]: value,
    };
    const invalid = {
      ...response,
      transactions: [
        { ...response.transactions[0], request },
        response.transactions[1],
      ],
    };
    expect(() => parseStatus(invalid, quote())).toThrowError(
      expect.objectContaining({ code: "RELAYR_INVALID_STATUS", status: 502 }),
    );
  });

  it("rejects missing, duplicate, foreign and extra status records", () => {
    const response = statusResponse();
    for (const invalid of [
      { ...response, bundle_uuid: TX_IDS[0] },
      { ...response, transactions: response.transactions.slice(0, 1) },
      {
        ...response,
        transactions: [...response.transactions, response.transactions[0]],
      },
      {
        ...response,
        transactions: [response.transactions[0], response.transactions[0]],
      },
      {
        ...response,
        transactions: [
          { ...response.transactions[0], tx_uuid: BUNDLE },
          response.transactions[1],
        ],
      },
      {
        ...response,
        transactions: [
          { ...response.transactions[0], request: null },
          response.transactions[1],
        ],
      },
    ]) {
      expect(() => parseStatus(invalid, quote())).toThrowError(
        expect.objectContaining({ code: "RELAYR_INVALID_STATUS" }),
      );
    }
  });

  it("rejects invalid or conflicting destination hashes and unbounded state labels", () => {
    const response = statusResponse();
    for (const status of [
      { state: "Broadcast", data: { hash: "0x1234" } },
      {
        state: "Broadcast",
        data: { hash: HASH, transaction: { hash: `0x${"cd".repeat(32)}` } },
      },
      { state: "x".repeat(65), data: {} },
      { state: 1, data: {} },
    ]) {
      expect(() =>
        parseStatus(
          {
            ...response,
            transactions: [
              { ...response.transactions[0], status },
              response.transactions[1],
            ],
          },
          quote(),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "RELAYR_INVALID_STATUS" }),
      );
    }
  });
});

describe("bounded fixed-origin Relayr transport", () => {
  it("uses Disabled ordering only for the explicit independent-deployment method", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ observed: true }));
    const provider = new RelayrProvider(fetcher);
    await provider.createIndependent(independentEntries());
    await provider.create(entries());
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ transactions: independentEntries(), virtual_nonce_mode: 'Disabled' });
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).virtual_nonce_mode).toBe('MultiChain');
  });
  it("uses only the fixed origin, exact create body and canonical status path with redirects disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ observed: true }),
    );
    const provider = new RelayrProvider(fetcher);
    await expect(provider.create(entries())).resolves.toEqual({
      observed: true,
    });
    await expect(provider.status(BUNDLE)).resolves.toEqual({ observed: true });
    expect(fetcher.mock.calls[0]![0]).toBe(
      `${RELAYR_ORIGIN}/v1/bundle/prepaid`,
    );
    expect(fetcher.mock.calls[1]![0]).toBe(
      `${RELAYR_ORIGIN}/v1/bundle/${BUNDLE}`,
    );
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      });
      expect(init).not.toHaveProperty("credentials");
    }
    expect(fetcher.mock.calls[0]![1]!.method).toBe("POST");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      transactions: entries(),
      virtual_nonce_mode: "MultiChain",
    });
    expect(fetcher.mock.calls[1]![1]!.method).toBe("GET");
    expect(fetcher.mock.calls[1]![1]).not.toHaveProperty("body");
  });

  it('rejects a supplied nonce in Disabled mode before publishing, matching the live HTTP 406 InvalidNonce response', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new RelayrProvider(fetcher).createIndependent(entries() as never)).rejects.toMatchObject({ code: 'RELAYR_INVALID_REQUEST' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => parseIndependentQuoteBinding(quoteResponse(), entries() as never, NOW)).toThrow();
  });
  it('authenticates omitted or null independent nonces without weakening ordered app nonce bindings', () => {
    const quote = parseIndependentQuoteBinding(quoteResponse(), independentEntries(), NOW);
    for (const nonce of [undefined, null]) {
      const status = statusResponse();
      for (const item of status.transactions) {
        delete (item.request as Partial<RelayrEntry>).virtual_nonce;
        if (nonce === null) Object.assign(item.request, { virtual_nonce: null });
      }
      expect(parseIndependentStatus(status, quote)).toHaveLength(2);
      expect(() => parseStatus(status, parseQuote(quoteResponse(), entries(), NOW, MAXIMUM_VALUE))).toThrow();
    }
    for (const nonce of [0, 1, '0', false]) {
      const status = statusResponse();
      for (const item of status.transactions) Object.assign(item.request, { virtual_nonce: nonce });
      expect(() => parseIndependentStatus(status, quote)).toThrow();
    }
    expect(() => parseIndependentStatus(statusResponse(), parseQuote(quoteResponse(), entries(), NOW, MAXIMUM_VALUE) as never)).toThrow();
  });

  it("rejects invalid status identifiers and already aborted requests without fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new RelayrProvider(fetcher);
    for (const id of [
      "../other",
      `${BUNDLE}?secret=value`,
      BUNDLE.toUpperCase(),
      "",
    ]) {
      await expect(provider.status(id)).rejects.toMatchObject({
        code: "INVALID_BUNDLE_ID",
        status: 400,
      });
    }
    await expect(
      provider.create(entries(), AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED", status: 499 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("decodes valid UTF-8 split across arbitrary response chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('{"name":"🍌"}');
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
    );
    await expect(new RelayrProvider(fetcher).status(BUNDLE)).resolves.toEqual({
      name: "🍌",
    });
  });

  it.each([
    "9999999999",
    String(RELAYR_LIMITS.maximumBytes + 1),
    "-1",
    "1e6",
    "invalid",
  ])(
    "cancels an invalid declared content length %s before reading",
    async (length) => {
      const cancel = vi.fn();
      const pull = vi.fn();
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
            { headers: { "content-length": length } },
          ),
      );
      await expect(
        new RelayrProvider(fetcher).status(BUNDLE),
      ).rejects.toMatchObject({ code: "RELAYR_RESPONSE_LIMIT", status: 502 });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "2"])(
    "caps actual response bytes even with content length %s and cancels unread data",
    async (declared) => {
      const cancel = vi.fn();
      const chunk = new Uint8Array(64 * 1024).fill(32);
      const pull = vi.fn(
        (controller: ReadableStreamDefaultController<Uint8Array>) =>
          controller.enqueue(chunk),
      );
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(new ReadableStream({ pull, cancel }), {
            headers:
              declared === undefined ? {} : { "content-length": declared },
          }),
      );
      await expect(
        new RelayrProvider(fetcher).status(BUNDLE),
      ).rejects.toMatchObject({ code: "RELAYR_RESPONSE_LIMIT" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(pull.mock.calls.length).toBeLessThanOrEqual(
        RELAYR_LIMITS.maximumBytes / chunk.byteLength + 2,
      );
    },
  );

  it.each([
    ["invalid JSON", new TextEncoder().encode(`{"${PRIVATE_ERROR}`)],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe])],
  ])("sanitizes %s failures", async (_name, bytes) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
    const error = await caught(new RelayrProvider(fetcher).status(BUNDLE));
    expect(error).toMatchObject({
      code: "RELAYR_INVALID_RESPONSE",
      status: 502,
    });
    expect(String(error)).not.toContain(PRIVATE_ERROR);
    expect(JSON.stringify(error)).not.toContain(PRIVATE_ERROR);
  });

  it("cancels failed HTTP responses and sanitizes body, redirect and fetch exceptions", async () => {
    const cancel = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(PRIVATE_ERROR));
              controller.close();
            },
            cancel,
          }),
          { status: 503 },
        ),
      )
      .mockRejectedValueOnce(new Error(PRIVATE_ERROR))
      .mockRejectedValueOnce(new TypeError(`redirect to ${PRIVATE_ERROR}`));
    const provider = new RelayrProvider(fetcher);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await caught(provider.status(BUNDLE));
      expect(error).toMatchObject({ code: "RELAYR_UNAVAILABLE", status: 502 });
      expect(String(error)).not.toContain(PRIVATE_ERROR);
      expect(JSON.stringify(error)).not.toContain(PRIVATE_ERROR);
    }
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps bounded HTTP diagnostics private from ordinary error serialization', async () => {
    const body = JSON.stringify({ error: PRIVATE_ERROR, bundle_uuid: BUNDLE });
    const error = await caught(new RelayrProvider(async () => new Response(body, { status: 406 })).createIndependent(independentEntries()));
    expect(error).toBeInstanceOf(RelayrResponseError);
    expect((error as RelayrResponseError).responseDetails).toEqual({ status: 406, body, complete: true, truncated: false });
    expect(String(error)).not.toContain(PRIVATE_ERROR);
    expect(JSON.stringify(error)).not.toContain(PRIVATE_ERROR);
  });

  it('retains the HTTP status and bounded prefix when an error body exceeds the limit', async () => {
    const error = await caught(new RelayrProvider(async () => new Response('x'.repeat(RELAYR_LIMITS.maximumBytes + 1), { status: 500 })).createIndependent(independentEntries()));
    expect(error).toMatchObject({ code: 'RELAYR_RESPONSE_LIMIT' });
    expect((error as RelayrResponseError).responseDetails).toEqual({ status: 500,
      body: 'x'.repeat(RELAYR_LIMITS.maximumBytes), complete: false, truncated: true });
  });

  it('retains the HTTP status and partial body when a rejected response stalls', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial error')); }, cancel,
    }), { status: 503 }));
    const result = caught(new RelayrProvider(fetcher, 50).createIndependent(independentEntries()));
    await vi.advanceTimersByTimeAsync(50);
    const error = await result;
    expect(error).toMatchObject({ code: 'RELAYR_TIMEOUT' });
    expect((error as RelayrResponseError).responseDetails).toEqual({ status: 503, body: 'partial error', complete: false, truncated: false });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a response with no body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null));
    await expect(
      new RelayrProvider(fetcher).status(BUNDLE),
    ).rejects.toMatchObject({ code: "RELAYR_INVALID_RESPONSE" });
  });

  it("finishes an explicit abort even when fetch ignores AbortSignal and cancels a late response", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const removed = vi.spyOn(external.signal, "removeEventListener");
    let answer!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const result = caught(
      new RelayrProvider(fetcher, 1000).create(entries(), external.signal),
    );
    external.abort();
    expect(await result).toMatchObject({
      code: "RELAYR_CANCELLED",
      status: 499,
    });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    const cancel = vi.fn();
    answer(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports a deadline as timeout and returns even when the fetcher never honors abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Promise<Response>(() => {}),
    );
    const result = caught(new RelayrProvider(fetcher, 50).create(entries()));
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ code: "RELAYR_TIMEOUT", status: 504 });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled body, cancels its reader and does not await a stuck cancel callback", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream({ cancel })),
    );
    const result = caught(new RelayrProvider(fetcher, 50).status(BUNDLE));
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ code: "RELAYR_TIMEOUT", status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer and external abort listener after successful completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true }),
    );
    await expect(
      new RelayrProvider(fetcher, 50).status(BUNDLE, controller.signal),
    ).resolves.toEqual({ success: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
