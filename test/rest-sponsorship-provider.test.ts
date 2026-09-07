import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  RelayrProvider,
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
    ["hex amount", { amount: "0x123" }],
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
      virtual_nonce_mode: "ChainIndependent",
    });
    expect(fetcher.mock.calls[1]![1]!.method).toBe("GET");
    expect(fetcher.mock.calls[1]![1]).not.toHaveProperty("body");
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
    expect(cancel).toHaveBeenCalledOnce();
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
