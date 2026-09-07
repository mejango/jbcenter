import type { Hex } from "viem";
import {
  accountStoreLimits,
  actorGrantId,
  assertAccount,
  assertActorAuthority,
  assertGrant,
  assertIdentifier,
  assertProfile,
  assertRequest,
  assertTime,
  authorityRequest,
  cleanupLimit,
  nonceCapacity,
  principalFor,
  RestAuthError,
  type Account,
  type AccountStore,
  type AccountStoreLimits,
  type AccountStoreOptions,
  type ActiveAuthority,
  type BotGrant,
  type Profile,
  type RestPrincipal,
  type RestActor,
  type BotScope,
  type VerifiedRequest,
} from "./store.js";

/** Each operation uses the same account mutex, including authority checks and revocations. */
class SerialLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const tail = new Promise<void>((resolve) => { unlock = resolve; });
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

type NonceEntry = { accountId: string; nonce: Hex; expiresAt: number; index: number };

/** An indexed expiry heap bounds global cleanup work without leaving stale heap entries. */
class NonceExpiryHeap {
  private readonly entries: NonceEntry[] = [];

  first(): NonceEntry | undefined { return this.entries[0]; }

  add(entry: NonceEntry): void {
    entry.index = this.entries.length;
    this.entries.push(entry);
    this.up(entry.index);
  }

  remove(entry: NonceEntry): void {
    const index = entry.index;
    const last = this.entries.pop();
    if (!last || last === entry) return;
    this.entries[index] = last;
    last.index = index;
    const parent = Math.floor((index - 1) / 2);
    if (index > 0 && this.entries[parent]!.expiresAt > last.expiresAt) this.up(index);
    else this.down(index);
  }

  private swap(a: number, b: number): void {
    const first = this.entries[a]!;
    this.entries[a] = this.entries[b]!;
    this.entries[b] = first;
    this.entries[a]!.index = a;
    first.index = b;
  }

  private up(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.entries[parent]!.expiresAt <= this.entries[index]!.expiresAt) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  private down(start: number): void {
    let index = start;
    while (index * 2 + 1 < this.entries.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const smallest = right < this.entries.length && this.entries[right]!.expiresAt < this.entries[left]!.expiresAt
        ? right : left;
      if (this.entries[index]!.expiresAt <= this.entries[smallest]!.expiresAt) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }
}

export class MemoryAccountStore implements AccountStore {
  private readonly limits: AccountStoreLimits;
  private readonly accounts = new Map<string, Account>();
  private readonly owners = new Map<string, string>();
  private readonly bots = new Map<string, BotGrant>();
  private readonly accountBots = new Map<string, Set<string>>();
  private readonly nonces = new Map<string, Map<Hex, NonceEntry>>();
  private readonly expiry = new NonceExpiryHeap();
  private readonly locks = new SerialLocks();

  constructor(options: AccountStoreOptions = {}) {
    this.limits = accountStoreLimits(options);
  }

  async getAccount(id: string): Promise<Account | null> {
    assertIdentifier(id);
    return structuredClone(this.accounts.get(id) ?? null);
  }

  async enroll(account: Account, request: VerifiedRequest): Promise<RestPrincipal> {
    assertAccount(account);
    assertRequest(request);
    const started = performance.now();
    return this.locks.run("enrollment", () => this.locks.run(`account:${account.id}`, () => {
      const currentRequest = this.afterWait(request, started);
      if (request.accountId !== account.id || request.grantId !== null
        || request.signer.toLowerCase() !== account.ownerAddress.toLowerCase()) {
        throw new RestAuthError("FORBIDDEN", 403, "Only the owner can enroll an account");
      }
      const ownerKey = `${account.authorityChainId}:${account.ownerAddress.toLowerCase()}`;
      const ownerAccount = this.owners.get(ownerKey);
      const existing = this.accounts.get(account.id);
      if ((ownerAccount && ownerAccount !== account.id) || (existing
        && (existing.ownerAddress.toLowerCase() !== account.ownerAddress.toLowerCase()
          || existing.authorityChainId !== account.authorityChainId))) {
        throw new RestAuthError("FORBIDDEN", 403, "Account identity does not match its owner");
      }
      if (!existing && this.accounts.size >= this.limits.maxAccounts) {
        throw new RestAuthError("STORAGE_LIMIT", 429, "Account storage limit exceeded");
      }
      const value = existing ?? { ...structuredClone(account), ownerAddress: account.ownerAddress.toLowerCase() as Account["ownerAddress"] };
      const principal = principalFor(value, null, currentRequest);
      this.consumeNonce(currentRequest);
      if (!existing) {
        this.accounts.set(value.id, value);
        this.owners.set(ownerKey, value.id);
      }
      return principal;
    }));
  }

  async authorizeAndConsume(request: VerifiedRequest): Promise<RestPrincipal> {
    assertRequest(request);
    const started = performance.now();
    return this.locks.run(`account:${request.accountId}`, () => {
      const currentRequest = this.afterWait(request, started);
      const account = this.account(request.accountId);
      const principal = principalFor(account, this.grant(request.grantId), currentRequest);
      this.consumeNonce(currentRequest);
      return principal;
    });
  }

  async assertActive(authority: ActiveAuthority): Promise<void> {
    const request = authorityRequest(authority);
    const started = performance.now();
    await this.locks.run(`account:${authority.accountId}`, () => {
      principalFor(this.account(authority.accountId), this.grant(authority.grantId), {
        ...request, now: authority.now + Math.floor((performance.now() - started) / 1_000),
      });
    });
  }

  async withActiveActor<T>(actor: RestActor, scopes: BotScope[], now: number, operation: () => Promise<T>): Promise<T> {
    const grantId = actorGrantId(actor);
    const started = performance.now();
    return this.locks.run(`account:${actor.accountId}`, async () => {
      assertActorAuthority(this.account(actor.accountId), this.grant(grantId), actor, scopes,
        now + Math.floor((performance.now() - started) / 1_000));
      return operation();
    });
  }

  async updateProfile(accountId: string, profile: Profile, now: number): Promise<Account> {
    assertIdentifier(accountId);
    assertProfile(profile);
    assertTime(now);
    return this.locks.run(`account:${accountId}`, () => {
      const account = this.account(accountId);
      const updated = { ...account, profile: structuredClone(profile), updatedAt: Math.max(account.updatedAt, now) };
      this.accounts.set(accountId, updated);
      return structuredClone(updated);
    });
  }

  async listBots(accountId: string): Promise<BotGrant[]> {
    assertIdentifier(accountId);
    this.account(accountId);
    return [...(this.accountBots.get(accountId) ?? [])].map((id) => structuredClone(this.bots.get(id)!))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async registerBot(grant: BotGrant): Promise<BotGrant> {
    assertGrant(grant);
    return this.locks.run(`account:${grant.accountId}`, () => {
      this.account(grant.accountId);
      if (this.bots.has(grant.id)) throw new RestAuthError("REPLAY", 409, "Bot grant identifier already exists");
      const ids = this.accountBots.get(grant.accountId) ?? new Set<string>();
      if (ids.size >= this.limits.maxGrantsPerAccount) {
        throw new RestAuthError("STORAGE_LIMIT", 429, "Account bot grant storage limit exceeded");
      }
      const value = { ...structuredClone(grant), botAddress: grant.botAddress.toLowerCase() as BotGrant["botAddress"] };
      this.bots.set(value.id, value);
      ids.add(value.id);
      this.accountBots.set(value.accountId, ids);
      return structuredClone(value);
    });
  }

  async revokeBot(accountId: string, grantId: string, now: number): Promise<BotGrant> {
    assertIdentifier(accountId);
    assertIdentifier(grantId);
    assertTime(now);
    return this.locks.run(`account:${accountId}`, () => {
      this.account(accountId);
      const grant = this.bots.get(grantId);
      if (!grant || grant.accountId !== accountId) throw new RestAuthError("GRANT_NOT_FOUND", 404, "Bot grant not found");
      const revoked = { ...grant, revokedAt: grant.revokedAt ?? Math.max(now, grant.createdAt) };
      this.bots.set(grantId, revoked);
      return structuredClone(revoked);
    });
  }

  async cleanupExpiredNonces(now: number, limit?: number): Promise<number> {
    assertTime(now);
    const maximum = cleanupLimit(limit);
    let removed = 0;
    let entry: NonceEntry | undefined;
    while (removed < maximum && (entry = this.expiry.first()) && entry.expiresAt <= now) {
      this.removeNonce(entry);
      removed++;
    }
    return removed;
  }

  private account(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) throw new RestAuthError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    return account;
  }

  private grant(id: string | null): BotGrant | null {
    return id === null ? null : this.bots.get(id) ?? null;
  }

  private afterWait(request: VerifiedRequest, started: number): VerifiedRequest {
    const current = { ...request, now: request.now + Math.floor((performance.now() - started) / 1_000) };
    assertRequest(current);
    return current;
  }

  private consumeNonce(request: VerifiedRequest): void {
    let entries = this.nonces.get(request.accountId);
    if (entries) {
      // Each account has at most 1000 entries; local cleanup is therefore bounded.
      for (const entry of entries.values()) {
        if (entry.expiresAt <= request.now) this.removeNonce(entry);
      }
    }
    entries = this.nonces.get(request.accountId) ?? new Map<Hex, NonceEntry>();
    const nonce = request.nonce.toLowerCase() as Hex;
    if (entries.has(nonce)) throw new RestAuthError("REPLAY", 409, "Authenticated request nonce was already used");
    if (entries.size >= nonceCapacity(this.limits.maxNoncesPerAccount, request.grantId)) {
      throw new RestAuthError("STORAGE_LIMIT", 429, "Account request nonce storage limit exceeded");
    }
    const entry = { accountId: request.accountId, nonce, expiresAt: request.expiresAt, index: -1 };
    entries.set(nonce, entry);
    this.nonces.set(request.accountId, entries);
    this.expiry.add(entry);
  }

  private removeNonce(entry: NonceEntry): void {
    const entries = this.nonces.get(entry.accountId)!;
    entries.delete(entry.nonce);
    if (!entries.size) this.nonces.delete(entry.accountId);
    this.expiry.remove(entry);
  }
}
