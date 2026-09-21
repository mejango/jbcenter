import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmnichainService, mapIndexedBridgeMovement } from "../src/rest/omnichain/index.js";
import type { OmnichainDependencies, OmnichainOptions, OmnichainProject } from "../src/rest/omnichain/types.js";

type Row = Record<string, unknown>;
const ROOT: OmnichainProject = { chainId: 8453, projectId: "1", version: 6 };
const OPTIMISM: OmnichainProject = { chainId: 10, projectId: "42", version: 6 };
const ARBITRUM: OmnichainProject = { chainId: 42161, projectId: "73", version: 6 };
const ETHEREUM: OmnichainProject = { chainId: 1, projectId: "101", version: 6 };
const ADDRESS = "0x1234567890123456789012345678901234567890";
const TOKEN = "0x9876543210987654321098765432109876543210";
const GROUP = "fixture-v6-group";
const TX_HASH = `0x${"a1".repeat(32)}`;
const OTHER_TX_HASH = `0x${"b2".repeat(32)}`;
const key = (value: unknown) => { const project = value as OmnichainProject; return `${project.chainId}:${project.projectId}`; };
const known = <T>(value: T) => ({ status: "known" as const, value });
const unknown = (code = "FIXTURE_UNAVAILABLE") => ({ status: "unknown" as const, error: { code, message: "Fixture data is unavailable.", retryable: true } });

function evidence(project: OmnichainProject) {
  return { chainId: project.chainId, blockNumber: "123456", blockHash: `0x${"11".repeat(32)}`, timestamp: "1800000000", source: "rpc" as const };
}

function state(project: OmnichainProject) {
  return {
    project: { ...project }, evidence: [evidence(project)], owner: known(ADDRESS), controller: known(ADDRESS), canonicalController: known(ADDRESS),
    token: known({ address: TOKEN, deployed: true, name: known("Fixture token"), symbol: known("FIX"), decimals: known(18) }),
    supply: { totalIncludingPendingReserved: known("100000000000000000000"), pendingReserved: known("100"), decimals: 18, scope: "localChain" },
    terminals: known([{ address: ADDRESS, accountingStore: known(ADDRESS), contexts: known([
      { token: TOKEN, decimals: 18, currency: "1", balance: known("100000000000000000000"), localSurplus: known("50000000000000000000"), units: { amount: "rawInteger", decimals: 18, currency: "1" } },
      { token: ADDRESS, decimals: 6, currency: "2", balance: known("123456789"), localSurplus: known("23456789"), units: { amount: "rawInteger", decimals: 6, currency: "2" } },
    ]) }]),
  };
}

function sucker(local: OmnichainProject, remote: OmnichainProject) {
  const value = BigInt(local.chainId) * 100_000_000n + BigInt(remote.chainId) * 100n + BigInt(local.projectId);
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function bridge(local: OmnichainProject, remote: OmnichainProject) {
  const remoteSucker = sucker(remote, local);
  return {
    address: sucker(local, remote),
    activeRegistryMember: known(true),
    state: known({ id: 0, name: "enabled" }),
    identity: known({ localProjectId: local.projectId, peer: `0x${"0".repeat(24)}${remoteSucker.slice(2)}`, peerChainId: String(remote.chainId),
      remote: known({ project: { ...remote }, sucker: remoteSucker, reciprocalRegistryMembershipVerified: true, evidence: evidence(remote) }),
    }),
    tokenStates: known([]), accountingGossip: known([]), outboxEvents: unknown("HISTORY_NOT_REQUESTED"),
  };
}

type OnchainFixture = ReturnType<typeof state> | { project: OmnichainProject; evidence: ReturnType<typeof evidence>[]; bridges: ReturnType<typeof known<ReturnType<typeof bridge>[]>> };
type OnchainMutation = (operation: "get_project" | "get_bridges", project: OmnichainProject, fixture: OnchainFixture) => unknown;
function onchain(graph: Map<string, OmnichainProject[]>, mutate?: OnchainMutation) {
  const execute = vi.fn<OmnichainDependencies["operations"]["execute"]>(async (operation, { project }) => {
    const fixture: OnchainFixture = operation === "get_project" ? state(project) : { project: { ...project }, evidence: [evidence(project)], bridges: known((graph.get(key(project)) ?? []).map((peer) => bridge(project, peer))) };
    const result = mutate?.(operation, project, fixture);
    return result === undefined ? fixture : result;
  });
  const read = vi.fn(async () => { throw new Error("On-chain mode must never query the indexer."); });
  const list = vi.fn(async () => { throw new Error("On-chain mode must never query the indexer."); });
  const service = createOmnichainService({ operations: { execute }, indexer: { read, list } as unknown as OmnichainDependencies["indexer"] });
  return { execute, read, list, service };
}

function indexedProject(project: OmnichainProject) {
  return { chainId: project.chainId, projectId: project.projectId, version: 6, id: key(project), suckerGroupId: GROUP,
    suckerGroup: { id: GROUP, version: 6 }, name: `Project ${project.projectId}`, owner: ADDRESS, token: TOKEN, tokenSymbol: "FIX", tokenSupply: "100000000000000000000", reservedTokenSupply: "100", balance: "100000000000000000000", balanceUsd: "11111", volume: "200000000000000000000", volumeUsd: "22222", decimals: 18, currency: "1", isRevnet: false };
}

function page(entity: string, items: Row[], nextCursor: string | null = null) {
  return { entity, network: "mainnet", protocolVersion: 6, items, totalCount: items.length,
    pageInfo: { hasNextPage: nextCursor !== null, hasPreviousPage: false, startCursor: items.length ? "cursor-first" : null, endCursor: nextCursor ?? (items.length ? "cursor-last" : null) },
    nextCursor, provenance: { fixtureSha256: "fixture-source" }, semantics: { snapshotPinned: false, executableAccounting: false },
  };
}

function movement(project: OmnichainProject, status = "pending"): Row {
  return { chainId: project.chainId, projectId: project.projectId, version: 6, suckerGroupId: GROUP, index: 1, token: TOKEN,
    createdAt: 1800000000, sucker: sucker(project, OPTIMISM), peer: sucker(OPTIMISM, project), peerChainId: OPTIMISM.chainId,
    beneficiary: ADDRESS, projectTokenCount: "1000000000000000000", terminalTokenAmount: "123456789", root: `0x${"22".repeat(32)}`, status };
}

function movementEvent(project: OmnichainProject, claim = false): Row {
  return { ...movement(project), id: claim ? "claim-event-id" : "source-event-id", txHash: claim ? OTHER_TX_HASH : TX_HASH,
    timestamp: 1800000000, caller: ADDRESS, from: ADDRESS, logIndex: 0,
    ...(claim ? { autoAddedToBalance: false, metadata: "0x" } : { hashed: `0x${"33".repeat(32)}` }),
  };
}

type IndexerMutation = (mode: "read" | "list", entity: string, input: Row, fixture: Row) => unknown;
function bendystraw(members: OmnichainProject[] = [ROOT, OPTIMISM], mutate?: IndexerMutation) {
  const read = vi.fn(async (entity: string, input: Row) => {
    const fixture = { entity, network: "mainnet", protocolVersion: 6, item: indexedProject(ROOT), provenance: { fixtureSha256: "fixture-source" }, semantics: { snapshotPinned: false } };
    const result = mutate?.("read", entity, input, fixture);
    return result === undefined ? fixture : result;
  });
  const list = vi.fn(async (entity: string, input: Row) => {
    const fixture = page(entity, entity === "project" ? members.map(indexedProject) : []);
    const result = mutate?.("list", entity, input, fixture);
    return result === undefined ? fixture : result;
  });
  const execute = vi.fn<OmnichainDependencies["operations"]["execute"]>(async () => { throw new Error("Bendystraw mode must never perform chain reads."); });
  const service = createOmnichainService({ operations: { execute }, indexer: { read, list } as unknown as OmnichainDependencies["indexer"] });
  return { execute, read, list, service };
}

afterEach(() => vi.restoreAllMocks());

describe("bounded traversal of verified on-chain peers", () => {
  it("discovers distinct project IDs across chains and deduplicates cyclic peers", async () => {
    const peers = [ROOT, OPTIMISM, ARBITRUM, ETHEREUM];
    const graph = new Map(peers.map((project) => [key(project), peers.filter((peer) => key(peer) !== key(project))]));
    const { service, execute, read, list } = onchain(graph);
    const result = await service.getProjectGroup(ROOT, { source: "onchain" });
    expect(result).toMatchObject({ source: "onchain", protocolVersion: 6, root: ROOT, groupId: null });
    expect(result.members.map((member) => key(member.project)).sort()).toEqual(peers.map(key).sort());
    expect(execute).toHaveBeenCalledTimes(8);
    expect(new Set(execute.mock.calls.map(([operation, { project }]) => `${operation}:${key(project)}`)).size).toBe(8);
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    for (const [, { project }, options] of execute.mock.calls) {
      expect(project.version).toBe(6);
      expect(options.source).toBe("onchain");
    }
  });

  it("reports truncation instead of expanding past maxMembers", async () => {
    const graph = new Map([[key(ROOT), [OPTIMISM, ARBITRUM]], [key(OPTIMISM), [ROOT, ETHEREUM]]]);
    const { service, execute } = onchain(graph);
    const result = await service.getProjectGroup(ROOT, { source: "onchain", maxMembers: 2 });
    expect(result.members).toHaveLength(2);
    expect(result.coverage).toMatchObject({ complete: false, maxMembers: 2 });
    expect(result.coverage.reasons.length).toBeGreaterThan(0);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("rejects a conflicting project on a chain already assigned to the group", async () => {
    const conflict: OmnichainProject = { ...ROOT, projectId: "999" };
    const { service } = onchain(new Map([[key(ROOT), [OPTIMISM]], [key(OPTIMISM), [conflict]]]));
    await expect(service.getProjectGroup(ROOT, { source: "onchain" })).rejects.toMatchObject({ code: "OMNICHAIN_LINK_CONFLICT" });
  });

  it("does not traverse unverified reciprocal peers", async () => {
    for (const remote of [unknown("REMOTE_UNAVAILABLE"), known({ project: OPTIMISM, sucker: sucker(OPTIMISM, ROOT), reciprocalRegistryMembershipVerified: false, evidence: evidence(OPTIMISM) })]) {
      const { service, execute } = onchain(new Map([[key(ROOT), [OPTIMISM]]]), (operation, _project, fixture) => {
        if (operation === "get_bridges") ((fixture as { bridges: { value: Row[] } }).bridges.value[0]!.identity as { value: Row }).value.remote = remote;
      });
      const result = await service.getProjectGroup(ROOT, { source: "onchain" });
      expect(result.members.map((member) => key(member.project))).toEqual([key(ROOT)]);
      expect(result.coverage.complete).toBe(false);
      expect(execute).toHaveBeenCalledTimes(2);
    }
  });

  it("retains unknown member reads and unavailable bridge discovery without source fallback", async () => {
    const { service, read, list } = onchain(new Map([[key(ROOT), [OPTIMISM]]]), (operation, project, fixture) => {
      if (key(project) === key(OPTIMISM) && operation === "get_project") throw new Error("private RPC provider URL must stay hidden");
      if (key(project) === key(OPTIMISM) && operation === "get_bridges") return { ...fixture, bridges: unknown() };
    });
    const result = await service.getProjectGroup(ROOT, { source: "onchain" });
    expect(result.members.find((member) => key(member.project) === key(OPTIMISM))?.state).toMatchObject({ status: "unknown" });
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private RPC provider URL");
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("preserves per-chain token-context raw units without inventing a combined balance", async () => {
    const { service } = onchain(new Map([[key(ROOT), [OPTIMISM]]]));
    const result = await service.getProjectGroup(ROOT, { source: "onchain" });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("100000000000000000000");
    expect(serialized).toContain("123456789");
    expect(serialized).toContain('"decimals":6');
    expect(serialized).toContain('"decimals":18');
    expect(result).not.toHaveProperty("totalBalance");
    expect(result).not.toHaveProperty("totalSupply");
  });

  it("does not confuse inactive registered bridges with verified settlement or erase their peers", async () => {
    const { service } = onchain(new Map([[key(ROOT), [OPTIMISM]]]), (operation, project, fixture) => {
      if (operation === "get_bridges" && key(project) === key(ROOT)) {
        const bridge = (fixture as { bridges: { value: Row[] } }).bridges.value[0]!;
        bridge.activeRegistryMember = known(false);
        bridge.state = known({ id: 3, name: "deprecated" });
      }
    });
    const result = await service.getProjectGroup(ROOT, { source: "onchain" });
    expect(result.members.map((member) => key(member.project))).toContain(key(OPTIMISM));
    expect(result.links[0]).toMatchObject({ linkageVerified: true, activeRegistryMember: known(false), state: known({ id: 3, name: "deprecated" }),
      lifecycle: { claimConfirmation: { status: "unknown" }, terminalCredit: { status: "unknown" }, crossChainSettlement: "unverified" } });
  });

  it("rejects inconsistent source identities, reciprocal peer configuration, and block evidence", async () => {
    const mutations: OnchainMutation[] = [
      (operation, _project, fixture) => { if (operation === "get_project") fixture.project = { ...ROOT, projectId: "999" }; },
      (operation, _project, fixture) => { if (operation === "get_project") fixture.evidence = [evidence(OPTIMISM)]; },
      (operation, _project, fixture) => { if (operation === "get_bridges") (((fixture as { bridges: { value: Row[] } }).bridges.value[0]!.identity as { value: Row }).value).localProjectId = "999"; },
      (operation, _project, fixture) => { if (operation === "get_bridges") (((fixture as { bridges: { value: Row[] } }).bridges.value[0]!.identity as { value: Row }).value).peerChainId = "1"; },
      (operation, _project, fixture) => { if (operation === "get_bridges") (((fixture as { bridges: { value: Row[] } }).bridges.value[0]!.identity as { value: Row }).value).peer = `0x${"0".repeat(24)}${ADDRESS.slice(2)}`; },
    ];
    for (const mutate of mutations) {
      const { service } = onchain(new Map([[key(ROOT), [OPTIMISM]]]), mutate);
      await expect(service.getProjectGroup(ROOT, { source: "onchain" })).rejects.toMatchObject({ status: 502, code: expect.stringMatching(/^OMNICHAIN_/u) });
    }
  });

  it("rejects verified remote members from an older protocol or another network class", async () => {
    for (const remote of [{ ...OPTIMISM, version: 4 }, { chainId: 84532, projectId: "1", version: 6 }]) {
      const { service } = onchain(new Map([[key(ROOT), [remote as OmnichainProject]]]));
      await expect(service.getProjectGroup(ROOT, { source: "onchain" })).rejects.toMatchObject({ code: expect.stringMatching(/^OMNICHAIN_/u) });
    }
  });

  it("bounds bridge, terminal and token-context arrays before returning a group", async () => {
    const mutations: OnchainMutation[] = [
      (operation, _project, fixture) => { if (operation === "get_bridges") return { ...fixture, bridges: known(Array.from({ length: 33 }, () => bridge(ROOT, OPTIMISM))) }; },
      (operation, _project, fixture) => { if (operation === "get_project") return { ...fixture, terminals: known(Array.from({ length: 33 }, () => state(ROOT).terminals.value[0])) }; },
      (operation, _project, fixture) => {
        if (operation === "get_project") {
          const terminal = state(ROOT).terminals.value[0]!;
          return { ...fixture, terminals: known([{ ...terminal, contexts: known(Array.from({ length: 33 }, () => terminal.contexts.value[0])) }]) };
        }
      },
    ];
    for (const mutate of mutations) {
      const { service } = onchain(new Map(), mutate);
      await expect(service.getProjectGroup(ROOT, { source: "onchain" })).rejects.toMatchObject({ code: "OMNICHAIN_RESPONSE_LIMIT" });
    }
  });

  it("preserves unknown treasury fields and independently pinned evidence", async () => {
    const { service } = onchain(new Map([[key(ROOT), [OPTIMISM]]]), (operation, project, fixture) => {
      if (operation === "get_project" && key(project) === key(OPTIMISM)) return { ...fixture, terminals: unknown("TERMINALS_UNKNOWN"), evidence: [{ ...evidence(project), blockNumber: "999999", blockHash: `0x${"ff".repeat(32)}` }] };
    });
    const result = await service.getProjectGroup(ROOT, { source: "onchain" });
    const member = result.members.find((member) => key(member.project) === key(OPTIMISM))!;
    expect(member.state).toMatchObject({ status: "known", value: { terminals: { status: "unknown", error: { code: "TERMINALS_UNKNOWN" } }, evidence: [{ chainId: 10, blockNumber: "999999" }] } });
    expect(result.coverage.simultaneousSnapshot).toBe(false);
    expect(JSON.stringify(member)).not.toContain('"balance":"0"');
  });
});

describe("explicit Bendystraw group and movement observations", () => {
  it("uses only indexed group membership and bounded per-member movement pages", async () => {
    const { service, execute, read, list } = bendystraw();
    const result = await service.getProjectGroup(ROOT, { source: "bendystraw" });
    expect(result).toMatchObject({ source: "bendystraw", protocolVersion: 6, groupId: GROUP });
    expect(result.members.map((member) => key(member.project)).sort()).toEqual([key(ROOT), key(OPTIMISM)].sort());
    expect(execute).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toBe("project");
    const groupQuery = list.mock.calls.find(([entity]) => entity === "project")!;
    expect(groupQuery[1].filters).toMatchObject({ suckerGroupId: GROUP });
    expect(groupQuery[1].limit).toBeLessThanOrEqual(9);
    const movements = list.mock.calls.filter(([entity]) => entity !== "project");
    expect(movements).toHaveLength(6);
    expect(new Set(movements.map(([entity]) => entity))).toEqual(new Set(["suckerTransaction", "bridgeToOutboxEvent", "bridgeClaimEvent"]));
    for (const [, input] of movements) expect(input).toMatchObject({ limit: 10, projectId: expect.any(String) });
    expect(result.movementPages).toHaveLength(2);
  });

  it("keeps the source unavailable when indexed discovery fails", async () => {
    const { service, execute } = bendystraw([ROOT], (mode) => { if (mode === "read") throw new Error("private indexer credential"); });
    const failure: unknown = await service.getProjectGroup(ROOT, { source: "bendystraw" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503 });
    expect(String(failure)).not.toContain("private indexer credential");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects mismatched indexed group membership and same-chain identity conflicts", async () => {
    for (const changed of [{ suckerGroupId: "foreign-group" }, { version: 4 }]) {
      const { service } = bendystraw([ROOT], (mode, entity, _input, fixture) => {
        if (mode === "list" && entity === "project") Object.assign((fixture.items as Row[])[0]!, changed);
      });
      await expect(service.getProjectGroup(ROOT, { source: "bendystraw" })).rejects.toMatchObject({ code: expect.stringMatching(/^OMNICHAIN_/u) });
    }
    for (const suckerGroup of [null, { id: "foreign-group", version: 6 }, { id: GROUP, version: 4 }]) {
      const { service } = bendystraw([ROOT], (mode, _entity, _input, fixture) => { if (mode === "read") (fixture.item as Row).suckerGroup = suckerGroup; });
      await expect(service.getProjectGroup(ROOT, { source: "bendystraw" })).rejects.toMatchObject({ status: 502 });
    }
    const conflicting = bendystraw([ROOT, { ...ROOT, projectId: "999" }]);
    await expect(conflicting.service.getProjectGroup(ROOT, { source: "bendystraw" })).rejects.toMatchObject({ code: "OMNICHAIN_LINK_CONFLICT" });
  });

  it("marks excess indexed members and movement cursors as incomplete coverage", async () => {
    const { service } = bendystraw([ROOT, OPTIMISM, ARBITRUM], (mode, entity, _input, fixture) => {
      if (mode === "list" && entity === "suckerTransaction") return { ...fixture, nextCursor: "next-transactions", pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: null, endCursor: "next-transactions" } };
    });
    const result = await service.getProjectGroup(ROOT, { source: "bendystraw", maxMembers: 2 });
    expect(result.members).toHaveLength(2);
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result.movementPages)).toContain("next-transactions");
  });

  it("retains the requested root even when it is absent from the first bounded membership page", async () => {
    const { service } = bendystraw([OPTIMISM, ARBITRUM]);
    const result = await service.getProjectGroup(ROOT, { source: "bendystraw", maxMembers: 2 });
    expect(result.members.map((member) => key(member.project))).toEqual([key(ROOT), key(OPTIMISM)]);
    expect(result.coverage.complete).toBe(false);
  });

  it("returns missing root records distinctly from outages and missing group relations", async () => {
    const missing = bendystraw([], (mode, _entity, _input, fixture) => { if (mode === "read") fixture.item = null; });
    await expect(missing.service.getProjectGroup(ROOT, { source: "bendystraw" })).rejects.toMatchObject({ code: "OMNICHAIN_PROJECT_NOT_FOUND", status: 404 });
    const unavailable = bendystraw([ROOT], (mode, entity) => { if (mode === "list" && entity === "project") throw new Error("private membership credential"); });
    const failure: unknown = await unavailable.service.getProjectGroup(ROOT, { source: "bendystraw" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503 });
    expect(String(failure)).not.toContain("private membership credential");
    expect(unavailable.execute).not.toHaveBeenCalled();
  });
});

describe("bridge movement hints remain distinct from confirmation", () => {
  it.each(["pending", "claimable", "claimed"])("keeps indexed %s separate from canonical proofs and settlement", (status) => {
    const mapped = mapIndexedBridgeMovement(movement(ROOT, status), [movementEvent(ROOT)]);
    expect(mapped).toMatchObject({ source: ROOT, indexedStatus: status,
      sourceTransaction: { status: "indexed-source-insertion", hash: TX_HASH, canonicalReceiptVerified: false },
      claimability: { liveProofValidated: false }, claimConfirmation: { canonicalReceiptVerified: false },
      terminalCredit: { status: "unknown" }, crossChainSettlement: { status: "unverified" },
      amounts: { projectTokenCount: "1000000000000000000", terminalTokenAmount: "123456789", decimals: null, currency: null },
    });
    if (status === "claimable") expect(mapped.claimability.status).toBe("indexed-claimable");
    if (status === "claimed") expect(mapped.claimConfirmation.status).toBe("indexed-claimed");
  });

  it("does not take a transaction hash from unrelated source events or the transaction row", () => {
    for (const changed of [{ chainId: 10 }, { projectId: "999" }, { version: 4 }, { token: ADDRESS }, { sucker: ADDRESS }, { index: 2 }]) {
      const mapped = mapIndexedBridgeMovement({ ...movement(ROOT), txHash: TX_HASH }, [{ ...movementEvent(ROOT), ...changed }]);
      expect(mapped.sourceTransaction).toEqual({ status: "unknown", canonicalReceiptVerified: false });
    }
  });

  it("rejects conflicting source hashes for the same movement and accepts duplicate identical evidence", () => {
    expect(() => mapIndexedBridgeMovement(movement(ROOT), [movementEvent(ROOT), { ...movementEvent(ROOT), txHash: OTHER_TX_HASH }])).toThrowError(expect.objectContaining({ code: "OMNICHAIN_MOVEMENT_CONFLICT" }));
    expect(mapIndexedBridgeMovement(movement(ROOT), [movementEvent(ROOT), movementEvent(ROOT)]).sourceTransaction).toMatchObject({ hash: TX_HASH });
  });

  it("returns destination claim event pages separately without asserting cross-chain confirmation", async () => {
    const { service } = bendystraw([ROOT], (mode, entity, _input, fixture) => {
      if (mode !== "list" || entity === "project") return;
      const items = entity === "suckerTransaction" ? [movement(ROOT, "claimed")] : [movementEvent(ROOT, entity === "bridgeClaimEvent")];
      return { ...fixture, items, totalCount: 1 };
    });
    const result = await service.getProjectGroup(ROOT, { source: "bendystraw" });
    const page = result.movementPages[0] as Row;
    expect(page.claimEvents).toMatchObject({ status: "known", value: { items: [expect.objectContaining({ txHash: OTHER_TX_HASH })] } });
    expect(page.mapped).toEqual([expect.objectContaining({ indexedStatus: "claimed", claimConfirmation: { status: "indexed-claimed", canonicalReceiptVerified: false }, crossChainSettlement: { status: "unverified" } })]);
  });

  it("keeps unavailable movement pages unknown and never substitutes empty confirmed history", async () => {
    const { service, execute } = bendystraw([ROOT], (mode, entity) => {
      if (mode === "list" && entity === "bridgeClaimEvent") throw new Error("private movement provider URL");
    });
    const result = await service.getProjectGroup(ROOT, { source: "bendystraw" });
    const page = result.movementPages[0] as Row;
    expect(page.claimEvents).toMatchObject({ status: "unknown" });
    expect(page.claimEvents).not.toHaveProperty("value");
    expect(JSON.stringify(result)).not.toContain("private movement provider URL");
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates every returned movement identity and page bound", async () => {
    for (const changed of [{ version: 4 }, { chainId: 10 }, { projectId: "999" }]) {
      const { service } = bendystraw([ROOT], (mode, entity, _input, fixture) => {
        if (mode === "list" && entity === "suckerTransaction") return { ...fixture, items: [{ ...movement(ROOT), ...changed }], totalCount: 1 };
      });
      await expect(service.getProjectGroup(ROOT, { source: "bendystraw" })).rejects.toMatchObject({ code: expect.stringMatching(/^OMNICHAIN_/u) });
    }
    const { service } = bendystraw([ROOT], (mode, entity, _input, fixture) => {
      if (mode === "list" && entity === "bridgeToOutboxEvent") return { ...fixture, items: Array.from({ length: 11 }, () => movementEvent(ROOT)), totalCount: 11 };
    });
    await expect(service.getProjectGroup(ROOT, { source: "bendystraw" })).rejects.toMatchObject({ code: "OMNICHAIN_RESPONSE_LIMIT" });
  });
});

describe("explicit source selection, V6 inputs, and cancellation", () => {
  it("rejects old protocol versions, invalid sources, and out-of-bound traversal sizes", async () => {
    const { service, execute, read, list } = onchain(new Map());
    await expect(service.getProjectGroup({ ...ROOT, version: 4 } as unknown as OmnichainProject, { source: "onchain" })).rejects.toMatchObject({ status: 400 });
    await expect(service.getProjectGroup(ROOT, { source: "auto" } as unknown as OmnichainOptions)).rejects.toMatchObject({ status: 400 });
    for (const maxMembers of [0, -1, 9, 1.5]) await expect(service.getProjectGroup(ROOT, { source: "onchain", maxMembers })).rejects.toMatchObject({ status: 400 });
    expect(execute).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["onchain", "bendystraw"] as const)("does not begin %s source work after cancellation", async (source) => {
    const { service, execute, read, list } = source === "onchain" ? onchain(new Map()) : bendystraw([ROOT]);
    const controller = new AbortController();
    controller.abort();
    await expect(service.getProjectGroup(ROOT, { source }, controller.signal)).rejects.toMatchObject({ code: "OMNICHAIN_CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("cancels an on-chain operation even when the injected dependency ignores its signal", async () => {
    const { service, execute, read, list } = onchain(new Map(), () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = service.getProjectGroup(ROOT, { source: "onchain" }, controller.signal);
    expect(execute).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OMNICHAIN_CANCELLED" });
    expect(execute.mock.calls[0]?.[2].signal?.aborted).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["read", "list"] as const)("cancels noncooperative indexed membership %s without fallback", async (blockedMode) => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const { service, execute } = bendystraw([ROOT], (mode, entity) => {
      if (mode === blockedMode && entity === "project") { began(); return new Promise(() => {}); }
    });
    const controller = new AbortController();
    const pending = service.getProjectGroup(ROOT, { source: "bendystraw" }, controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OMNICHAIN_CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["onchain", "bendystraw"] as const)("enforces the overall deadline for a stalled %s dependency", async (source) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const { service } = source === "onchain" ? onchain(new Map(), () => new Promise(() => {})) : bendystraw([ROOT], () => new Promise(() => {}));
    const pending = service.getProjectGroup(ROOT, { source });
    expect(timeout).toHaveBeenCalledWith(60_000);
    deadline.abort();
    await expect(pending).rejects.toMatchObject({ code: "OMNICHAIN_CANCELLED" });
  });
});
