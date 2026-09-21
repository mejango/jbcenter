import type { Hex } from "viem";
import type { RestActor } from "../core.js";
import { assertActor, assertText } from "../transactions/store.js";
import { RELAYR_LIMITS } from "./constants.js";
import type {
  DestinationObservation,
  RelayrEntry,
  RelayrQuote,
  SponsorshipRecord,
} from "./types.js";
import { assertKey, clone, fail, hash, same } from "./validation.js";

export interface SponsorshipClaim {
  actor: RestActor;
  id: string;
  key: string;
  hash: Hex;
  entries: RelayrEntry[];
  now: number;
  authorization?: { issuedAt: number; expiresAt: number };
}
export interface SponsorshipStore {
  find(
    actor: RestActor,
    key: string,
    inputHash: Hex,
  ): Promise<SponsorshipRecord | undefined>;
  create(record: SponsorshipRecord, now: number): Promise<SponsorshipRecord>;
  get(actor: RestActor, id: string): Promise<SponsorshipRecord | undefined>;
  /** Atomic active-grant check + permanent transport reservation BEFORE provider publication. */
  claim(
    input: SponsorshipClaim,
  ): Promise<{ record: SponsorshipRecord; dispatch: boolean }>;
  /** Internal settlement: accepts only the exact previously reserved submission. */
  settle(
    id: string,
    submissionHash: Hex,
    quote?: RelayrQuote,
    runtimeVerified?: boolean,
  ): Promise<SponsorshipRecord>;
  observe(
    id: string,
    revision: number,
    observations: DestinationObservation[],
  ): Promise<SponsorshipRecord>;
}
export function owns(record: SponsorshipRecord, actor: RestActor): boolean {
  return (
    record.actor.accountId === actor.accountId &&
    record.actor.principalId === actor.principalId
  );
}
export function canRead(record: SponsorshipRecord, actor: RestActor): boolean {
  return (
    owns(record, actor) ||
    (record.actor.accountId === actor.accountId &&
      actor.principalId === `owner:${actor.accountId}`)
  );
}
export function missing(): never {
  return fail(
    "SPONSORSHIP_NOT_FOUND",
    "Sponsorship preparation was not found for this principal.",
    404,
  );
}
export function conflict(): never {
  return fail(
    "SPONSORSHIP_CONFLICT",
    "The sponsorship binding is already reserved for a different request.",
    409,
  );
}
export function assertNew(record: SponsorshipRecord, now: number): void {
  assertActor(record.actor);
  assertText(record.id);
  assertText(record.planId);
  assertKey(record.preparationKey);
  if (
    !hash(record.commitment) ||
    !hash(record.planCommitment) ||
    !hash(record.inputHash) ||
    record.state !== "prepared" ||
    record.revision !== 0 ||
    record.submission ||
    record.quote ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.createdAt > now ||
    record.expiresAt <= now ||
    record.createdAt < 0 ||
    record.requests.length < 1 ||
    record.requests.length > RELAYR_LIMITS.maximumCalls ||
    record.observations.length !== 0 ||
    new Set(record.requests.map((r) => r.stepIndex)).size !==
      record.requests.length ||
    record.requests.some(
      (r) =>
        !Number.isInteger(r.stepIndex) || r.stepIndex < 0 || r.stepIndex > 31,
    )
  )
    fail(
      "INVALID_SPONSORSHIP_RECORD",
      "Invalid initial sponsorship preparation.",
      400,
    );
  clone(record);
}
export function assertClaim(input: SponsorshipClaim): void {
  assertActor(input.actor);
  assertText(input.id);
  assertKey(input.key);
  if (
    !hash(input.hash) ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !Array.isArray(input.entries) ||
    input.entries.length < 1 ||
    input.entries.length > RELAYR_LIMITS.maximumCalls
  )
    fail(
      "INVALID_SPONSORSHIP_CLAIM",
      "Invalid sponsorship publication claim.",
      400,
    );
  clone(input);
}
export function claimed(
  record: SponsorshipRecord,
  input: SponsorshipClaim,
): { record: SponsorshipRecord; dispatch: boolean } {
  if (!owns(record, input.actor)) return missing();
  if (record.submission) {
    if (
      record.submission.key !== input.key ||
      !same(record.submission.hash, input.hash)
    )
      return conflict();
    return { record: clone(record), dispatch: false };
  }
  if (record.state !== "prepared" || record.expiresAt <= input.now)
    fail(
      "SPONSORSHIP_EXPIRED",
      "Prepare a fresh plan before publishing an authorization.",
      409,
    );
  if (input.authorization !== undefined)
    assertDispatchAuthorization(input.authorization, input.now);
  return {
    record: {
      ...clone(record),
      revision: record.revision + 1,
      state: "submitting",
      submission: {
        key: input.key,
        hash: input.hash,
        entries: clone(input.entries),
        startedAt: input.now,
      },
    },
    dispatch: true,
  };
}
export function assertDispatchAuthorization(
  authorization: { issuedAt: number; expiresAt: number },
  now: number,
): void {
  const { issuedAt, expiresAt } = authorization ?? {};
  const seconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt < 0 ||
    issuedAt > seconds + 30 ||
    expiresAt <= seconds ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 300
  ) {
    fail(
      "AUTH_EXPIRED",
      "Publication approval expired or has an invalid validity window. Sign a fresh request.",
      401,
    );
  }
}
export function settled(
  record: SponsorshipRecord,
  submissionHash: Hex,
  quote?: RelayrQuote,
  runtimeVerified = true,
): SponsorshipRecord {
  if (!record.submission || !same(record.submission.hash, submissionHash))
    return conflict();
  if (record.quote) {
    if (quote && !same(record.quote.commitment, quote.commitment))
      return conflict();
    if (quote && runtimeVerified && !record.quoteRuntimeVerified)
      return clone({
        ...record,
        revision: record.revision + 1,
        quoteRuntimeVerified: true,
      });
    return clone(record);
  }
  if (!quote && record.state === "submission_unknown") return clone(record);
  return clone({
    ...record,
    revision: record.revision + 1,
    state: quote ? "quoted" : "submission_unknown",
    ...(quote ? { quote, quoteRuntimeVerified: runtimeVerified } : {}),
  });
}
