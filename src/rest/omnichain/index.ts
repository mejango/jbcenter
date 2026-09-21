import { RestError } from "../core.js";
import type { IndexerNetwork } from "../indexer/index.js";
import {
  OMNICHAIN_LIMITS as L,
  type OmnichainDependencies,
  type OmnichainMember,
  type OmnichainOptions,
  type OmnichainProject,
} from "./types.js";

export * from "./types.js";
type Row = Record<string, unknown>;
type Observation<T> =
  | { status: "known"; value: T }
  | { status: "unknown"; error: { code: string; message: string } };
const CHAINS: Record<number, IndexerNetwork> = {
  1: "mainnet",
  10: "mainnet",
  8453: "mainnet",
  42161: "mainnet",
  11155111: "testnet",
  11155420: "testnet",
  84532: "testnet",
  421614: "testnet",
};
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
function fail(code: string, message: string, status = 502): never {
  throw new RestError(status, code, message);
}
const known = <T>(value: T): Observation<T> => ({ status: "known", value });
const unknown = (
  code: string,
  message = "The selected source did not provide verified data for this field.",
): Observation<never> => ({ status: "unknown", error: { code, message } });
function record(value: unknown): Row {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "The selected source returned a malformed object.",
    );
  return value as Row;
}
function project(value: unknown): OmnichainProject {
  const input = record(value);
  if (
    input.version !== 6 ||
    !Number.isSafeInteger(input.chainId) ||
    !Object.hasOwn(CHAINS, String(input.chainId)) ||
    typeof input.projectId !== "string" ||
    !/^[1-9]\d{0,77}$/.test(input.projectId) ||
    BigInt(input.projectId) >= 1n << 256n
  )
    fail(
      "OMNICHAIN_INVALID_IDENTITY",
      "Use a supported chain, positive exact project ID, and explicit version 6.",
      400,
    );
  return {
    chainId: input.chainId as number,
    projectId: input.projectId,
    version: 6,
  };
}
const key = (ref: OmnichainProject) => `${ref.chainId}:${ref.projectId}:6`;
function matchingProject(
  value: unknown,
  expected: OmnichainProject,
): OmnichainProject {
  const actual = project(value);
  if (key(actual) !== key(expected))
    fail(
      "OMNICHAIN_IDENTITY_MISMATCH",
      "The selected source returned a different project identity.",
    );
  return actual;
}
function observation(value: unknown): Observation<unknown> {
  const item = record(value);
  if (item.status === "known" && Object.hasOwn(item, "value"))
    return known(item.value);
  if (item.status === "unknown") {
    const error =
      item.error && typeof item.error === "object" ? (item.error as Row) : {};
    const code =
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
        ? error.code
        : "SOURCE_UNKNOWN";
    return unknown(code);
  }
  fail(
    "OMNICHAIN_INVALID_RESPONSE",
    "The source did not preserve known and unknown state.",
  );
}
function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    fail(
      "OMNICHAIN_RESPONSE_LIMIT",
      "The source array exceeds its declared bound.",
    );
  return value;
}
function evidence(value: unknown, expectedChainId: number): Row[] {
  const items = boundedArray(value, 8);
  if (!items.length)
    fail("OMNICHAIN_INVALID_RESPONSE", "Onchain reads require block evidence.");
  return items.map((item) => {
    const block = record(item);
    if (
      block.chainId !== expectedChainId ||
      !["rpc", "onchain"].includes(String(block.source)) ||
      typeof block.blockHash !== "string" ||
      !HASH.test(block.blockHash) ||
      typeof block.blockNumber !== "string" ||
      !/^\d+$/.test(block.blockNumber) ||
      typeof block.timestamp !== "string" ||
      !/^\d+$/.test(block.timestamp)
    )
      fail(
        "OMNICHAIN_INVALID_RESPONSE",
        "Onchain block evidence has the wrong chain or shape.",
      );
    return {
      chainId: block.chainId,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      timestamp: block.timestamp,
      source: block.source,
    };
  });
}
function address(value: unknown): string {
  if (
    typeof value !== "string" ||
    !ADDRESS.test(value) ||
    /^0x0{40}$/i.test(value)
  )
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "A bridge relation contains an invalid EVM address.",
    );
  return value;
}
function peerAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(value))
    fail(
      "OMNICHAIN_UNSUPPORTED_PEER",
      "The source peer is not a supported EVM address.",
    );
  return address(`0x${value.slice(-40)}`);
}
function exactAmount(value: unknown): string {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d{0,99})$/.test(value))
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "Indexed amounts must remain exact decimal strings.",
    );
  return value;
}
function onchainState(raw: unknown, ref: OmnichainProject) {
  const data = record(raw);
  matchingProject(data.project, ref);
  const terminals = observation(data.terminals);
  if (terminals.status === "known") {
    for (const terminal of boundedArray(
      terminals.value,
      L.terminalsPerMember,
    )) {
      const item = record(terminal);
      const contexts = observation(item.contexts);
      if (contexts.status === "known") {
        for (const rawContext of boundedArray(
          contexts.value,
          L.contextsPerTerminal,
        )) {
          const context = record(rawContext);
          if (
            typeof context.token !== "string" ||
            !ADDRESS.test(context.token) ||
            typeof context.decimals !== "number" ||
            !Number.isInteger(context.decimals) ||
            context.decimals < 0 ||
            context.decimals > 255 ||
            !["string", "number"].includes(typeof context.currency)
          )
            fail(
              "OMNICHAIN_INVALID_RESPONSE",
              "Terminal accounting units are malformed.",
            );
          const balance = observation(context.balance);
          if (balance.status === "known") exactAmount(balance.value);
        }
      }
    }
  }
  return {
    owner: observation(data.owner),
    controller: observation(data.controller),
    token: observation(data.token),
    supply: record(data.supply),
    terminals,
    evidence: evidence(data.evidence, ref.chainId),
  };
}
function indexedState(data: Row) {
  if (
    typeof data.owner !== "string" ||
    !ADDRESS.test(data.owner) ||
    (data.token !== null &&
      (typeof data.token !== "string" || !ADDRESS.test(data.token)))
  )
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "Indexed project addresses are malformed.",
    );
  if (
    data.decimals !== null &&
    (typeof data.decimals !== "number" ||
      !Number.isInteger(data.decimals) ||
      data.decimals < 0 ||
      data.decimals > 255)
  )
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "Indexed decimals are unknown or an exact integer in range.",
    );
  if (data.currency !== null) exactAmount(data.currency);
  return {
    owner: data.owner,
    indexedBalance: {
      amount: exactAmount(data.balance),
      usdEstimate: exactAmount(data.balanceUsd),
      decimals: data.decimals,
      currency: data.currency,
      accountingAsset: "not-enumerated-by-this-indexed-aggregate",
      spendabilityVerified: false,
    },
    issuedProjectToken: {
      address: data.token,
      symbol: data.tokenSymbol,
      totalSupply: exactAmount(data.tokenSupply),
      reservedSupply: exactAmount(data.reservedTokenSupply),
    },
    units:
      "Decimals and currency are copied from the indexed project. The issued project token is not assumed to be its treasury accounting asset.",
    snapshotPinned: false,
  };
}

const PROJECT_FIELDS = [
  "suckerGroupId",
  "owner",
  "balance",
  "balanceUsd",
  "decimals",
  "currency",
  "token",
  "tokenSymbol",
  "tokenSupply",
  "reservedTokenSupply",
];
const SEMANTICS = {
  aggregation:
    "No amounts are summed across projects, tokens, terminals, currencies, or chains. Each member preserves its own source units and unknown fields.",
  onchain:
    "Only reciprocal sucker registry membership establishes an onchain linkage. Bytecode equivalence is not attested. Separate reads and chains have separate block evidence; no simultaneous cross-chain snapshot is claimed.",
  bendystraw:
    "Indexer group membership and bridge states are discovery data, not verified reciprocal contract linkage, executable claimability or canonical transaction receipts.",
  settlement:
    "A successful source transaction is not destination delivery or settlement. Indexed claimed is not canonical claim confirmation. Claims and terminal credit remain separate evidence requirements.",
  gossip:
    "Bridge accounting gossip is last-received remote accounting; it is not a simultaneously read remote balance and is never added to local treasury balances.",
} as const;

function sourceEventKey(item: Row, sourceChain: number): string | undefined {
  if (
    typeof item.sucker !== "string" ||
    !ADDRESS.test(item.sucker) ||
    typeof item.token !== "string" ||
    !ADDRESS.test(item.token) ||
    !["string", "number"].includes(typeof item.index) ||
    !/^(0|[1-9]\d*)$/.test(String(item.index)) ||
    (typeof item.index === "number" && !Number.isSafeInteger(item.index))
  )
    return undefined;
  return `${sourceChain}:${item.sucker.toLowerCase()}:${item.token.toLowerCase()}:${String(item.index)}`;
}
/** Maps indexed hints without elevating them into canonical source/destination proof. */
export function mapIndexedBridgeMovement(
  transaction: Row,
  sourceEvents: Row[] = [],
) {
  const source = project(transaction);
  if (!["pending", "claimable", "claimed"].includes(String(transaction.status)))
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "The indexed bridge lifecycle status is unsupported.",
    );
  const identity = sourceEventKey(transaction, source.chainId);
  if (!identity)
    fail(
      "OMNICHAIN_INVALID_RESPONSE",
      "The indexed movement lacks a complete sucker/token/index identity.",
    );
  const matches = sourceEvents.filter(
    (event) =>
      event.chainId === source.chainId &&
      String(event.projectId) === source.projectId &&
      event.version === 6 &&
      sourceEventKey(event, source.chainId) === identity,
  );
  const hashes = [
    ...new Set(
      matches
        .map((event) => event.txHash)
        .filter(
          (hash): hash is string => typeof hash === "string" && HASH.test(hash),
        ),
    ),
  ];
  if (hashes.length > 1)
    fail(
      "OMNICHAIN_MOVEMENT_CONFLICT",
      "Indexed source insertion events disagree for the same movement identity.",
    );
  return {
    identity,
    source,
    peerChainId: transaction.peerChainId,
    sucker: transaction.sucker,
    token: transaction.token,
    index: String(transaction.index),
    beneficiary: transaction.beneficiary,
    amounts: {
      projectTokenCount: exactAmount(transaction.projectTokenCount),
      terminalTokenAmount: exactAmount(transaction.terminalTokenAmount),
      decimals: null,
      currency: null,
    },
    indexedStatus: transaction.status,
    sourceTransaction:
      hashes.length === 1
        ? {
            status: "indexed-source-insertion",
            hash: hashes[0]!,
            canonicalReceiptVerified: false,
          }
        : { status: "unknown", canonicalReceiptVerified: false },
    transport: {
      status:
        transaction.status === "pending"
          ? "indexed-pending"
          : "not-independently-verified",
    },
    claimability: {
      status:
        transaction.status === "claimable"
          ? "indexed-claimable"
          : "not-independently-verified",
      liveProofValidated: false,
    },
    claimConfirmation: {
      status: transaction.status === "claimed" ? "indexed-claimed" : "unknown",
      canonicalReceiptVerified: false,
    },
    terminalCredit: { status: "unknown" },
    crossChainSettlement: { status: "unverified" },
  };
}

export function createOmnichainService(dependencies: OmnichainDependencies) {
  return new OmnichainService(dependencies);
}
export class OmnichainService {
  constructor(private readonly dependencies: OmnichainDependencies) {}
  async getProjectGroup(
    rawProject: OmnichainProject,
    options: OmnichainOptions,
    signal?: AbortSignal,
  ) {
    const root = project(rawProject);
    if (
      Object.keys(record(rawProject)).some(
        (name) => !["chainId", "projectId", "version"].includes(name),
      )
    )
      fail(
        "OMNICHAIN_INVALID_INPUT",
        "Project identities contain only chain, project ID and version.",
        400,
      );
    if (
      Object.keys(record(options)).some(
        (name) => !["source", "maxMembers"].includes(name),
      ) ||
      !["onchain", "bendystraw"].includes(options.source)
    )
      fail(
        "OMNICHAIN_INVALID_INPUT",
        "Choose onchain or bendystraw explicitly.",
        400,
      );
    const maxMembers =
      options.maxMembers === undefined ? L.maxMembers : options.maxMembers;
    if (
      !Number.isInteger(maxMembers) ||
      maxMembers < 1 ||
      maxMembers > L.maxMembers
    )
      fail(
        "OMNICHAIN_INVALID_INPUT",
        "The member limit must be between 1 and 8.",
        400,
      );
    const controller = new AbortController();
    const combined = AbortSignal.any([
      AbortSignal.timeout(L.timeoutMs),
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    try {
      const completed = await this.read<unknown>(
        () =>
          options.source === "onchain"
            ? this.onchain(root, maxMembers, combined)
            : this.indexed(root, maxMembers, combined),
        combined,
      );
      if (completed.status === "unknown")
        fail(
          completed.error.code,
          "The explicitly selected source could not resolve this omnichain group.",
          503,
        );
      const result = completed.value as
        | Awaited<ReturnType<OmnichainService["onchain"]>>
        | Awaited<ReturnType<OmnichainService["indexed"]>>;
      if (Buffer.byteLength(JSON.stringify(result)) > L.maxResponseBytes)
        fail(
          "OMNICHAIN_RESPONSE_LIMIT",
          "The omnichain result exceeds its byte bound. Request fewer members.",
        );
      return result;
    } finally {
      controller.abort();
    }
  }
  private async read<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<Observation<T>> {
    let cancel: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(
            new RestError(
              499,
              "OMNICHAIN_CANCELLED",
              "The omnichain read was cancelled or exceeded its deadline.",
            ),
          );
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
      if (signal.aborted) await cancelled;
      return known(await Promise.race([work(), cancelled]));
    } catch (error) {
      if (signal.aborted)
        throw new RestError(
          499,
          "OMNICHAIN_CANCELLED",
          "The omnichain read was cancelled or exceeded its deadline.",
        );
      // Structural and identity failures are never downgraded into a source outage.
      if (error instanceof RestError && error.code.startsWith("OMNICHAIN_"))
        throw error;
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
          ? error.code
          : "SOURCE_UNAVAILABLE";
      return unknown(code);
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
    }
  }
  private chainMembership(
    byChain: Map<number, string>,
    member: OmnichainProject,
    root: OmnichainProject,
  ) {
    if (CHAINS[member.chainId] !== CHAINS[root.chainId])
      fail(
        "OMNICHAIN_NETWORK_MISMATCH",
        "A member belongs to a different mainnet/testnet network class.",
      );
    const existing = byChain.get(member.chainId);
    if (existing !== undefined && existing !== member.projectId)
      fail(
        "OMNICHAIN_LINK_CONFLICT",
        "Reciprocal or indexed linkage selects conflicting project IDs on the same chain.",
      );
    byChain.set(member.chainId, member.projectId);
  }
  private async onchain(
    root: OmnichainProject,
    maxMembers: number,
    signal: AbortSignal,
  ) {
    const queue: Array<{ project: OmnichainProject; linkage: string }> = [
      { project: root, linkage: "requested-root" },
    ];
    const visited = new Set<string>([key(root)]);
    const byChain = new Map<number, string>([[root.chainId, root.projectId]]);
    const members: OmnichainMember[] = [];
    const links: Row[] = [];
    const reasons = new Set<string>();
    for (let next = 0; next < queue.length; next++) {
      const entry = queue[next]!;
      const ref = entry.project;
      const [state, bridgeRead] = await Promise.all([
        this.read(
          async () =>
            onchainState(
              await this.dependencies.operations.execute(
                "get_project",
                { project: ref },
                { source: "onchain", signal },
              ),
              ref,
            ),
          signal,
        ),
        this.read(async () => {
          const data = record(
            await this.dependencies.operations.execute(
              "get_bridges",
              { project: ref },
              { source: "onchain", signal },
            ),
          );
          matchingProject(data.project, ref);
          return {
            bridges: observation(data.bridges),
            evidence: evidence(data.evidence, ref.chainId),
          };
        }, signal),
      ]);
      if (state.status === "unknown") reasons.add("member-state-unavailable");
      members.push({
        project: ref,
        linkage: entry.linkage,
        state,
        bridgeEvidence:
          bridgeRead.status === "known"
            ? known(bridgeRead.value.evidence)
            : bridgeRead,
      });
      if (
        bridgeRead.status === "unknown" ||
        bridgeRead.value.bridges.status === "unknown"
      ) {
        reasons.add("bridge-discovery-unavailable");
        continue;
      }
      for (const rawBridge of boundedArray(
        bridgeRead.value.bridges.value,
        L.bridgesPerMember,
      )) {
        const bridge = record(rawBridge);
        const localSucker = address(bridge.address);
        const identity = observation(bridge.identity);
        const common = {
          from: ref,
          localSucker,
          activeRegistryMember: observation(bridge.activeRegistryMember),
          state: observation(bridge.state),
          accountingGossip: observation(bridge.accountingGossip),
          tokenStates: observation(bridge.tokenStates),
          lifecycle: {
            sourceInsertions: observation(bridge.outboxEvents),
            destinationClaimability: unknown("DESTINATION_PROOF_NOT_CHECKED"),
            claimConfirmation: unknown("DESTINATION_RECEIPT_NOT_CHECKED"),
            terminalCredit: unknown("DESTINATION_TERMINAL_CREDIT_NOT_CHECKED"),
            crossChainSettlement: "unverified",
          },
        };
        if (identity.status === "unknown") {
          reasons.add("unverified-peer-linkage");
          links.push({ ...common, linkageVerified: false, remote: identity });
          continue;
        }
        const local = record(identity.value);
        if (String(local.localProjectId) !== ref.projectId)
          fail(
            "OMNICHAIN_IDENTITY_MISMATCH",
            "A registered sucker reports another local project.",
          );
        const remote = observation(local.remote);
        if (remote.status === "unknown") {
          reasons.add("unverified-peer-linkage");
          links.push({ ...common, linkageVerified: false, remote });
          continue;
        }
        const verified = record(remote.value);
        if (verified.reciprocalRegistryMembershipVerified !== true) {
          reasons.add("unverified-peer-linkage");
          links.push({
            ...common,
            linkageVerified: false,
            remote: unknown("RECIPROCAL_REGISTRY_NOT_VERIFIED"),
          });
          continue;
        }
        const destination = project(verified.project);
        const remoteSucker = address(verified.sucker);
        if (
          String(local.peerChainId) !== String(destination.chainId) ||
          peerAddress(local.peer).toLowerCase() !== remoteSucker.toLowerCase()
        )
          fail(
            "OMNICHAIN_IDENTITY_MISMATCH",
            "The verified remote identity disagrees with the local peer configuration.",
          );
        this.chainMembership(byChain, destination, root);
        const remoteEvidence = evidence(
          [verified.evidence],
          destination.chainId,
        );
        links.push({
          ...common,
          linkageVerified: true,
          remote: known({
            project: destination,
            sucker: remoteSucker,
            evidence: remoteEvidence,
            reciprocalRegistryMembershipVerified: true,
          }),
        });
        if (visited.has(key(destination))) continue;
        visited.add(key(destination));
        if (queue.length >= maxMembers) {
          reasons.add("member-limit");
          continue;
        }
        queue.push({
          project: destination,
          linkage: "verified-reciprocal-sucker",
        });
      }
    }
    return {
      source: "onchain" as const,
      protocolVersion: 6 as const,
      root,
      groupId: null,
      members,
      links,
      movementPages: [],
      coverage: {
        membership: "verified-reciprocal-registry",
        completeScope: "membership-discovery",
        complete: reasons.size === 0,
        reasons: [...reasons].sort(),
        maxMembers,
        visitedMembers: members.length,
        discoveredIdentities: visited.size,
        historyScanned: false,
        movementHistoryComplete: false,
        simultaneousSnapshot: false,
      },
      semantics: SEMANTICS,
    };
  }
  private async indexed(
    root: OmnichainProject,
    maxMembers: number,
    signal: AbortSignal,
  ) {
    const network = CHAINS[root.chainId]!;
    const rootRead = await this.dependencies.indexer.read(
      "project",
      {
        network,
        chainId: root.chainId,
        projectId: root.projectId,
        fields: [...PROJECT_FIELDS, "suckerGroup.id", "suckerGroup.version"],
      },
      signal,
    );
    if (rootRead.item === null)
      fail(
        "OMNICHAIN_PROJECT_NOT_FOUND",
        "The selected indexer has no V6 record for the requested project.",
        404,
      );
    const rootData = record(rootRead.item);
    matchingProject(rootData, root);
    const groupId = rootData.suckerGroupId;
    if (typeof groupId !== "string" || !groupId || groupId.length > 2048)
      fail(
        "OMNICHAIN_GROUP_UNAVAILABLE",
        "The indexed project does not have a bounded group identity.",
      );
    if (rootData.suckerGroup === null || rootData.suckerGroup === undefined)
      fail(
        "OMNICHAIN_GROUP_UNAVAILABLE",
        "The indexer's group relation is unavailable; membership is unknown.",
      );
    const relation = record(rootData.suckerGroup);
    if (relation.id !== groupId || relation.version !== 6)
      fail(
        "OMNICHAIN_GROUP_MISMATCH",
        "The indexed group relation disagrees with the project's V6 group identity.",
      );
    const page = await this.dependencies.indexer.list(
      "project",
      {
        network,
        filters: { suckerGroupId: groupId },
        fields: PROJECT_FIELDS,
        limit: maxMembers + 1,
      },
      signal,
    );
    const byChain = new Map<number, string>();
    const selected = new Map<
      string,
      { project: OmnichainProject; data: Row }
    >();
    const reasons = new Set<string>();
    const add = (data: Row) => {
      const member = project(data);
      if (data.suckerGroupId !== groupId)
        fail(
          "OMNICHAIN_GROUP_MISMATCH",
          "The indexer returned a project from a different group.",
        );
      this.chainMembership(byChain, member, root);
      if (selected.has(key(member))) return;
      if (selected.size >= maxMembers) {
        reasons.add("member-limit");
        return;
      }
      selected.set(key(member), { project: member, data });
    };
    add(rootData);
    for (const item of boundedArray(page.items, maxMembers + 1))
      add(record(item));
    if (page.pageInfo.hasNextPage) reasons.add("indexed-membership-page-limit");
    const members: OmnichainMember[] = [...selected.values()].map(
      ({ project, data }) => ({
        project,
        linkage: "indexed-group-discovery",
        state: known(indexedState(data)),
      }),
    );
    const movementPages: Row[] = [];
    for (const member of members) {
      const ref = member.project;
      const base = {
        network,
        chainId: ref.chainId,
        projectId: ref.projectId,
        limit: L.movementsPerMember,
      };
      const [transactions, sourceEvents, claimEvents] = await Promise.all([
        this.read(
          () =>
            this.dependencies.indexer.list(
              "suckerTransaction",
              {
                ...base,
                fields: [
                  "index",
                  "token",
                  "sucker",
                  "peer",
                  "peerChainId",
                  "beneficiary",
                  "status",
                  "projectTokenCount",
                  "terminalTokenAmount",
                ],
              },
              signal,
            ),
          signal,
        ),
        this.read(
          () =>
            this.dependencies.indexer.list(
              "bridgeToOutboxEvent",
              {
                ...base,
                fields: [
                  "txHash",
                  "timestamp",
                  "sucker",
                  "token",
                  "index",
                  "peerChainId",
                ],
              },
              signal,
            ),
          signal,
        ),
        this.read(
          () =>
            this.dependencies.indexer.list(
              "bridgeClaimEvent",
              {
                ...base,
                fields: [
                  "txHash",
                  "timestamp",
                  "sucker",
                  "token",
                  "index",
                  "peerChainId",
                  "autoAddedToBalance",
                ],
              },
              signal,
            ),
          signal,
        ),
      ]);
      const checkPage = (observed: typeof transactions): Row[] => {
        if (observed.status === "unknown") return [];
        return boundedArray(observed.value.items, L.movementsPerMember).map(
          (item) => {
            const row = record(item);
            matchingProject(row, ref);
            return row;
          },
        );
      };
      const sourceRows = checkPage(sourceEvents);
      const transactionRows = checkPage(transactions);
      checkPage(claimEvents);
      movementPages.push({
        project: ref,
        transactions,
        sourceEvents,
        claimEvents,
        mapped: transactionRows.map((transaction) =>
          mapIndexedBridgeMovement(transaction, sourceRows),
        ),
        coverage:
          "Each entity is a separate bounded page. Missing events in these pages do not establish absence. Indexed destination claim events are supplied separately and are not treated as canonical confirmations or automatically matched across bridge token mappings.",
      });
    }
    return {
      source: "bendystraw" as const,
      protocolVersion: 6 as const,
      root,
      groupId,
      members,
      links: [],
      movementPages,
      coverage: {
        membership: "indexed-group-discovery-only",
        completeScope: "membership-discovery",
        complete: reasons.size === 0,
        reasons: [...reasons].sort(),
        maxMembers,
        visitedMembers: members.length,
        indexedGroupTotal: page.totalCount,
        nextCursor: page.nextCursor,
        linkageVerified: false,
        movementHistoryComplete: false,
        simultaneousSnapshot: false,
      },
      provenance: rootRead.provenance,
      semantics: SEMANTICS,
    };
  }
}
