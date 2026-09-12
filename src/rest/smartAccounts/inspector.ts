import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  padHex,
  parseAbi,
  stringToHex,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { RestError, type RestRpc } from "../core.js";
import {
  SAFE_CREATION_ABI,
  SAFE_SETUP_ABI,
  verifySafe7579CreationCall,
} from "./creation.js";
import { fingerprint } from "./service.js";
import {
  LEGACY_SESSION_PARAMETERS,
  LEGACY_SESSION_SETUP_ABI,
} from "./setup.js";
import type {
  ContractPin,
  ModuleStateEvidence,
  SmartAccountManifest,
  SmartModuleInspector,
  SmartSnapshot,
} from "./types.js";
import type {
  Safe7579CheckpointStore,
  Safe7579HistoryCheckpoint,
} from "./checkpoints.js";

export const SAFE7579_INSPECTOR_ID = "safe7579-f22a194-trace-v1";
export const SAFE7579_STORAGE_SOURCE = Object.freeze({
  repository: "https://github.com/rhinestonewtf/safe7579",
  commit: "f22a194148ff087f0c16125e530512e59794e188",
  compiler: "0.8.30+commit.73712a01",
  verificationInputSha256:
    "955d410efa0870df00bfddc9c2ea25bccf37451403da245af5e90a82ac45ffdb",
  artifactSha256:
    "5e40d3584872cd8bc0cea680f720a69c1cc49656e3f69e796deed718bb7cd37c",
  slots: {
    registry: 0,
    emergencyNonces: 1,
    validators: 2,
    executors: 3,
    fallbacks: 4,
    globalHook: 5,
    emergencyUninstallTime: 6,
    prevalidation4337: 7,
    prevalidation1271: 8,
  },
});
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const MODULE_ABI = parseAbi([
  "function getValidatorsPaginated(address cursor,uint256 pageSize) view returns(address[] array,address next)",
  "function getExecutorsPaginated(address cursor,uint256 pageSize) view returns(address[] array,address next)",
  "function getActiveHook() view returns(address)",
  "function getPrevalidationHook(uint256 moduleType) view returns(address)",
  "function getNonce(address safe,address validator) view returns(uint256)",
  "function entryPoint() view returns(address)",
  "function installModule(uint256 moduleType,address module,bytes initData)",
  "function uninstallModule(uint256 moduleType,address module,bytes initData)",
  "function initializeAccount((address module,bytes initData,uint256 moduleType)[] modules,(address registry,address[] attesters,uint8 threshold) registryInit)",
  "function initializeAccountWithValidators((address module,bytes initData,uint256 moduleType)[] validators)",
  "event ModuleInstalled(uint256 moduleTypeId,address module)",
  "event ModuleUninstalled(uint256 moduleTypeId,address module)",
]);
const SAFE_LIFECYCLE_ABI = parseAbi([
  "function enableModule(address module)",
  "function disableModule(address previous,address module)",
  "function setFallbackHandler(address handler)",
  "function setGuard(address guard)",
  "function addOwnerWithThreshold(address owner,uint256 threshold)",
  "function removeOwner(address previous,address owner,uint256 threshold)",
  "function swapOwner(address previous,address oldOwner,address newOwner)",
  "function changeThreshold(uint256 threshold)",
]);
const ENTRY_ABI = parseAbi([
  "function getNonce(address sender,uint192 key) view returns(uint256)",
]);
const creationTopic = keccak256(stringToHex("ProxyCreation(address,address)"));
const installedTopic = keccak256(
  stringToHex("ModuleInstalled(uint256,address)"),
);
const uninstalledTopic = keccak256(
  stringToHex("ModuleUninstalled(uint256,address)"),
);
const initializedTopic = keccak256(stringToHex("Safe7579Initialized(address)"));
const userOperationTopic = keccak256(
  stringToHex(
    "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
  ),
);
const SESSION_MUTATION_ABI = parseAbi([
  "function onInstall(bytes data)",
  "function onUninstall(bytes data)",
  "function validateUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp,bytes32 userOpHash)",
]);
const selectorOf = (signature: string) =>
  keccak256(stringToHex(signature)).slice(0, 10);
const sessionAdminSelectors = new Set(
  [
    "disableActionId(bytes32,bytes32)",
    "disableActionPolicies(bytes32,bytes32,address[])",
    "disableERC1271Policies(bytes32,address[],(bytes32,string[])[])",
    "disableUserOpPolicies(bytes32,address[])",
    "enableActionPolicies(bytes32,(bytes4,address,(address,bytes)[])[])",
    "enableERC1271Policies(bytes32,((bytes32,string[])[],(address,bytes)[]))",
    "enableUserOpPolicies(bytes32,(address,bytes)[])",
    "removeSession(bytes32)",
    "revokeEnableSignature(bytes32)",
    "setPermit4337Paymaster(bytes32,bool)",
    "onUninstall(bytes)",
  ].map(selectorOf),
);
/** Exhaustive non-view selector inventory from the pinned legacy SmartSession ABI. */
export const SAFE7579_SESSION_STATEFUL_SELECTORS = Object.freeze([
  ...sessionAdminSelectors,
  selectorOf("onInstall(bytes)"),
  toFunctionSelector(LEGACY_SESSION_SETUP_ABI[0]),
  selectorOf(
    "validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
  ),
]);
const sessionViewSelectors = new Set([
  "0x2dadb5e9",
  "0x1097109e",
  "0x2445e73e",
  "0xd527ed6e",
  "0xa67c714e",
  "0xa9fa4b44",
  "0xd0e6f608",
  "0x795f9269",
  "0x7373f181",
  "0x1be1fffb",
  "0x05defba6",
  "0x496c8a91",
  "0x44d1628c",
  "0xaf29e6b2",
  "0x09e5aef8",
  "0xa7ef6205",
  "0xeab25667",
  "0xc9a5ec39",
  "0xd60b347f",
  "0xecd05961",
  "0xadbc532f",
  "0xf77a7eac",
  "0xf551e2ee",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isWord = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
function fail(code: string, message: string, status = 422): never {
  throw new RestError(status, code, message);
}
function hex(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v))
    fail("SMART_INSPECTION_RPC_INVALID", "RPC returned invalid bytes.", 502);
  return v as Hex;
}
function quantity(v: unknown): bigint {
  if (
    typeof v !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v) ||
    v.length > 66
  )
    fail(
      "SMART_INSPECTION_RPC_INVALID",
      "RPC returned an invalid quantity.",
      502,
    );
  return BigInt(v);
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail(
      "SMART_INSPECTION_RPC_INVALID",
      "RPC returned an invalid object.",
      502,
    );
  return v as Record<string, unknown>;
}
function storedAddress(v: unknown): Address {
  if (!isWord(v) || !/^0x0{24}/i.test(v))
    fail(
      "SMART_INSPECTION_STORAGE_INVALID",
      "A module storage word contains a noncanonical address.",
    );
  return getAddress(`0x${v.slice(-40)}`);
}
/** Mapping keys use Solidity ABI padding; bytes4 keys, unlike addresses, are right-padded. */
export function safe7579MappingSlot(account: Address, slot: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [account, BigInt(slot)],
    ),
  );
}
export function safe7579ListSlot(
  account: Address,
  entry: Address,
  slot: 2 | 3,
): Hex {
  const outer = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [entry, BigInt(slot)],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [account, outer],
    ),
  );
}
export function safe7579FallbackSlot(account: Address, selector: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector))
    fail(
      "SMART_INSPECTION_INPUT_INVALID",
      "A fallback selector must be four bytes.",
      400,
    );
  const outer = keccak256(
    encodeAbiParameters(
      [{ type: "bytes4" }, { type: "uint256" }],
      [selector, 4n],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [account, outer],
    ),
  );
}

export interface Safe7579SessionAuthorityEvidence {
  stateHash: Hex;
  permissionIds: readonly Hex[];
  arbitrarySigningDisabled: true;
  wildcardExecutionDisabled: true;
  gasBudgetEnforced: true;
}
export interface Safe7579InspectorOptions {
  rpc: RestRpc;
  /** Host-owned utility pin: f22a194 stores this immutable in executable adapter code. */
  utility: ContractPin;
  /** Must enumerate and verify every installed permission at this exact canonical snapshot. */
  inspectSessions(input: {
    account: Address;
    manifest: SmartAccountManifest;
    snapshot: SmartSnapshot;
  }): Promise<Safe7579SessionAuthorityEvidence>;
  /** Maximum blocks containing source-proven authority ingress; dormant blocks do not count. */
  maxHistoryBlocks?: number;
  maxHistoryTransactions?: number;
  maxLogRequests?: number;
  maxLogRangeBlocks?: number;
  maxLogBytes?: number;
  maxTraceFramesPerBlock?: number;
  maxCachedAccounts?: number;
  timeoutMs?: number;
  creationLogs?: (chainId: number, factory: Address, account: Address, end: bigint, signal?: AbortSignal) => Promise<Record<string, unknown>[] | undefined>;
  /** Retained server-verified history; never populated from an HTTP request or client assertion. */
  checkpointStore?: Safe7579CheckpointStore;
}
interface Header {
  hash: Hex;
  parentHash: Hex;
  number: bigint;
  transactions: Hex[];
}
interface Provenance {
  creationBlock: bigint;
  creationHash: Hex;
  creationTransaction: Hex;
  initializerHash: Hex;
  lastBlock: bigint;
  lastHash: Hex;
  authorityHash: Hex;
  lifecycleChanges: number;
  sessionAdministration: Safe7579HistoryCheckpoint["sessionAdministration"];
}

/** Exhaustive for the strict, source-pinned profile. Registry enforcement is disabled in this
 * revision. Unknown fallback/type-0 history is rejected because the selector mapping is not
 * enumerable. Complete canonical traces also exclude hidden owner delegatecalls which could
 * transiently replace the Safe singleton and suppress or forge ordinary module events. */
export function createSafe7579Inspector(
  options: Safe7579InspectorOptions,
): SmartModuleInspector {
  const limits = {
    history: options.maxHistoryBlocks ?? 4096,
    transactions: options.maxHistoryTransactions ?? 10000,
    logs: options.maxLogRequests ?? 2048,
    logRange: options.maxLogRangeBlocks ?? 50000,
    logBytes: options.maxLogBytes ?? 16 * 1024 * 1024,
    frames: options.maxTraceFramesPerBlock ?? 100000,
    cache: options.maxCachedAccounts ?? 256,
    timeout: options.timeoutMs ?? 30000,
  };
  for (const n of Object.values(limits))
    if (!Number.isSafeInteger(n) || n < 1)
      fail(
        "SMART_INSPECTOR_CONFIG_INVALID",
        "Inspector limits must be positive bounded integers.",
        500,
      );
  if (
    limits.history > 100000 ||
    limits.transactions > 100000 ||
    limits.logs > 10000 ||
    limits.logRange > 50000 ||
    limits.logBytes > 64 * 1024 * 1024 ||
    limits.frames > 1000000 ||
    limits.cache > 10000 ||
    limits.timeout > 120000 ||
    options.utility.source.commit !== SAFE7579_STORAGE_SOURCE.commit ||
    !isWord(options.utility.runtimeCodeHash)
  )
    fail(
      "SMART_INSPECTOR_CONFIG_INVALID",
      "Use the reviewed utility and bounded inspection limits.",
      500,
    );
  const cache = new Map<string, Provenance>();

  return {
    id: SAFE7579_INSPECTOR_ID,
    async inspect({
      account,
      manifest: m,
      snapshot,
    }): Promise<ModuleStateEvidence> {
      if (
        m.moduleInspectorId !== SAFE7579_INSPECTOR_ID ||
        m.safe7579.source.commit !== SAFE7579_STORAGE_SOURCE.commit ||
        m.safe7579.source.artifactSha256 !==
          SAFE7579_STORAGE_SOURCE.artifactSha256 ||
        m.smartSessions.generation !== "legacy-validator" ||
        m.singleton.runtimeCodeHash.toLowerCase() !==
          "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff" ||
        m.singleton.source.commit !==
          "bf943f80fec5ac647159d26161446ac5d716a294" ||
        !m.entryPoint ||
        !same(m.entryPoint.address, ENTRY_POINT) ||
        m.entryPoint.version !== "0.7" ||
        snapshot.evidence.chainId !== m.chainId ||
        !same(snapshot.evidence.blockHash, snapshot.tag.blockHash)
      )
        fail(
          "SMART_INSPECTOR_SOURCE_MISMATCH",
          "The inspector requires its exact reviewed adapter, legacy validator and EntryPoint 0.7.",
        );
      account = getAddress(account);
      const end = BigInt(snapshot.evidence.blockNumber);
      const deadline = AbortSignal.timeout(limits.timeout);
      const rpc = (method: string, params: readonly unknown[]) =>
        options.rpc.request(m.chainId, method, params, deadline);
      if (quantity(await rpc("eth_chainId", [])) !== BigInt(m.chainId))
        fail(
          "SMART_INSPECTION_CHAIN_MISMATCH",
          "Inspection RPC is on another chain.",
        );
      const headers = new Map<bigint, Header>();
      async function header(n: bigint): Promise<Header> {
        const found = headers.get(n);
        if (found) {
          headers.delete(n);
          headers.set(n, found);
          return found;
        }
        const raw = record(
          await rpc("eth_getBlockByNumber", [toHex(n), false]),
        );
        if (
          !isWord(raw.hash) ||
          !isWord(raw.parentHash) ||
          quantity(raw.number) !== n ||
          !Array.isArray(raw.transactions) ||
          raw.transactions.length > 10000 ||
          !raw.transactions.every(isWord)
        )
          fail(
            "SMART_INSPECTION_RPC_INVALID",
            "A complete canonical block header is required.",
            502,
          );
        const result = {
          hash: raw.hash,
          parentHash: raw.parentHash,
          number: n,
          transactions: raw.transactions as Hex[],
        };
        headers.set(n, result);
        if (headers.size > 64) headers.delete(headers.keys().next().value!);
        return result;
      }
      let logRequests = 0;
      let logBytes = 0;
      async function logs(
        address: Address,
        topics: (Hex | Hex[] | null)[],
        from: bigint,
        to: bigint,
      ) {
        const result: Record<string, unknown>[] = [];
        const pending = from <= to ? [{ start: from, finish: to }] : [];
        while (pending.length) {
          let { start, finish } = pending.pop()!;
          const pageEnd = start + BigInt(limits.logRange) - 1n;
          if (finish > pageEnd) { pending.push({start:pageEnd+1n,finish}); finish=pageEnd; }
          if (++logRequests > limits.logs)
            fail(
              "SMART_HISTORY_LIMIT",
              "Complete module history exceeds the configured log budget.",
              503,
            );
          let page: unknown;
          try {
            page = await rpc("eth_getLogs", [
              {
                address,
                topics,
                fromBlock: toHex(start),
                toBlock: toHex(finish),
              },
            ]);
          } catch {
            page = undefined;
          }
          if (!Array.isArray(page) || page.length >= 10000) {
            if (start === finish || deadline.aborted)
              fail(
                "SMART_HISTORY_INCOMPLETE",
                "Log history is unavailable or may have been truncated.",
                503,
              );
            const middle = (start + finish) / 2n;
            pending.push(
              { start: middle + 1n, finish },
              { start, finish: middle },
            );
            continue;
          }
          for (const v of page) {
            const log = record(v);
            logBytes += new TextEncoder().encode(
              JSON.stringify(log),
            ).byteLength;
            if (logBytes > limits.logBytes)
              fail(
                "SMART_HISTORY_LIMIT",
                "Complete module history exceeds the configured log byte budget.",
                503,
              );
            if (
              typeof log.address !== "string" ||
              !same(log.address, address) ||
              log.removed !== false ||
              !isWord(log.blockHash) ||
              !isWord(log.transactionHash) ||
              !Array.isArray(log.topics) ||
              log.topics.length > 4 ||
              !log.topics.every(isWord) ||
              typeof log.data !== "string" ||
              !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) ||
              quantity(log.blockNumber) < start ||
              quantity(log.blockNumber) > finish ||
              topics.some(
                (filter, index) =>
                  filter !== null &&
                  (!isWord((log.topics as Hex[])[index]) ||
                    !(Array.isArray(filter)
                      ? filter.some((t) =>
                          same(t, (log.topics as Hex[])[index]!),
                        )
                      : same(filter, (log.topics as Hex[])[index]!))),
              )
            )
              fail(
                "SMART_HISTORY_INCOMPLETE",
                "RPC logs do not match the requested complete history.",
                503,
              );
            result.push(log);
            if (result.length > 10000)
              fail(
                "SMART_HISTORY_LIMIT",
                "Module history exceeds the configured event budget.",
                503,
              );
          }
        }
        result.sort((a, b) =>
          Number(
            quantity(a.blockNumber) - quantity(b.blockNumber) ||
              quantity(a.logIndex) - quantity(b.logIndex),
          ),
        );
        const seen = new Set<string>();
        for (const log of result) {
          const key = `${log.blockHash}:${log.logIndex}`;
          if (seen.has(key))
            fail("SMART_HISTORY_INCOMPLETE", "Duplicate history log.", 503);
          seen.add(key);
        }
        return result;
      }
      const key = `${m.chainId}:${account.toLowerCase()}:${m.revision}:${options.utility.runtimeCodeHash}`;
      const candidates: Provenance[] = [];
      const cached = cache.get(key);
      if (cached) candidates.push(cached);
      if (options.checkpointStore) {
        const retained = await options.checkpointStore.get(key);
        if (!Array.isArray(retained) || retained.length > 128)
          fail(
            "SMART_CHECKPOINT_INVALID",
            "Invalid retained authority history.",
            503,
          );
        for (const candidate of retained) {
          if (
            candidate.schemaVersion !== 2 ||
            candidate.key !== key ||
            !/^(0|[1-9][0-9]{0,19})$/.test(candidate.creationBlock) ||
            !/^(0|[1-9][0-9]{0,19})$/.test(candidate.lastBlock) ||
            BigInt(candidate.creationBlock) > BigInt(candidate.lastBlock) ||
            ![
              candidate.creationHash,
              candidate.creationTransaction,
              candidate.initializerHash,
              candidate.lastHash,
              candidate.authorityHash,
            ].every(isWord) ||
            !Number.isSafeInteger(candidate.lifecycleChanges) ||
            candidate.lifecycleChanges < 0 ||
            !candidate.sessionAdministration ||
            !/^(0|[1-9][0-9]{0,77})$/.test(
              candidate.sessionAdministration.epoch,
            ) ||
            !isWord(candidate.sessionAdministration.hash)
          )
            fail(
              "SMART_CHECKPOINT_INVALID",
              "Invalid retained authority history.",
              503,
            );
          candidates.push({
            ...structuredClone(candidate),
            creationBlock: BigInt(candidate.creationBlock),
            lastBlock: BigInt(candidate.lastBlock),
          });
        }
      }
      candidates.sort((a, b) =>
        a.lastBlock > b.lastBlock ? -1 : a.lastBlock < b.lastBlock ? 1 : 0,
      );
      let history: Provenance | undefined;
      for (const candidate of candidates) {
        if (
          candidate.lastBlock <= end &&
          same((await header(candidate.lastBlock)).hash, candidate.lastHash)
        ) {
          history = structuredClone(candidate);
          break;
        }
      }
      if (!history) cache.delete(key);
      let prepared: ReturnType<typeof verifySafe7579CreationCall> | undefined;
      if (!history) {
        // The indexed proxy topic identifies the first and only CREATE2 deployment by this immutable
        // factory. This rules out destroyed/recreated accounts retaining old adapter mapping state.
        const creations = await options.creationLogs?.(m.chainId, m.factory.address, account, end, deadline) ?? await logs(
          m.factory.address,
          [creationTopic, padHex(account, { size: 32 })],
          0n,
          end,
        );
        if (creations.length !== 1)
          fail(
            "SMART_CREATION_PROOF_REQUIRED",
            "A unique canonical deployment by the reviewed Safe factory is required.",
          );
        const creation = creations[0]!;
        const creationBlock = quantity(creation.blockNumber);
        const h = await header(creationBlock);
        if (!same(h.hash, String(creation.blockHash)))
          fail(
            "SMART_HISTORY_REORG",
            "The account creation receipt is no longer canonical.",
            409,
          );
        const receipt = record(
          await rpc("eth_getTransactionReceipt", [creation.transactionHash]),
        );
        const tx = record(
          await rpc("eth_getTransactionByHash", [creation.transactionHash]),
        );
        if (
          quantity(receipt.status) !== 1n ||
          !same(String(receipt.blockHash), h.hash) ||
          !same(String(tx.blockHash), h.hash) ||
          !same(
            String(receipt.transactionHash),
            String(creation.transactionHash),
          ) ||
          !same(String(tx.to), m.factory.address) ||
          quantity(tx.value) !== 0n ||
          !Array.isArray(receipt.logs) ||
          !receipt.logs.some((v) => {
            const l = record(v);
            return (
              l.logIndex === creation.logIndex &&
              l.data === creation.data &&
              l.address === creation.address
            );
          })
        )
          fail(
            "SMART_CREATION_PROOF_REQUIRED",
            "The successful factory transaction and creation receipt must match.",
          );
        const event = decodeEventLog({
          abi: SAFE_CREATION_ABI,
          data: hex(creation.data),
          topics: creation.topics as [Hex, ...Hex[]],
        });
        if (
          !same(event.args.proxy, account) ||
          !same(event.args.singleton, m.singleton.address)
        )
          fail(
            "SMART_CREATION_PROOF_REQUIRED",
            "Creation uses another Safe singleton.",
          );
        prepared = verifySafe7579CreationCall(m, account, hex(tx.input));
        await Promise.all([
          m.factory,
          m.singleton,
          m.safe7579,
          m.launchpad,
          m.smartSessions,
          m.entryPoint,
          options.utility,
        ].map(async pin => {
          const code = hex(
            await rpc("eth_getCode", [
              pin.address,
              { blockHash: h.hash, requireCanonical: true },
            ]),
          );
          if (code === "0x" || !same(keccak256(code), pin.runtimeCodeHash))
            fail(
              "SMART_HISTORY_CODE_MISMATCH",
              "Creation did not use the reviewed immutable stack.",
            );
        }));
        history = {
          creationBlock,
          creationHash: h.hash,
          creationTransaction: creation.transactionHash as Hex,
          initializerHash: prepared.initializerHash,
          lastBlock: creationBlock - 1n,
          lastHash: h.parentHash,
          authorityHash: fingerprint({
            account: account.toLowerCase(),
            chainId: m.chainId,
            factory: m.factory.address.toLowerCase(),
            initializerHash: prepared.initializerHash,
          }),
          lifecycleChanges: 0,
          sessionAdministration: {
            epoch: "0",
            hash: fingerprint({
              account: account.toLowerCase(),
              chainId: m.chainId,
              creationTransaction: creation.transactionHash,
              kind: "session-administration",
            }),
          },
        };
      } else history = { ...history };
      const start = history.lastBlock + 1n;
      // SafeL2 emits SafeMultiSigTransaction / SafeModuleTransaction before dispatch. Every
      // successful owner/module effect therefore leaves a Safe log, including an inner code
      // replacement: an outer revert that removes that log also removes all inner state effects.
      // With only this adapter installed and no handlers/hooks, the only additional authority
      // ingress is initialization (adapter event) or EntryPoint validation (sender event).
      const [safeEvents, initializationEvents, userOperationEvents] = await Promise.all([
        logs(account, [], start, end),
        logs(m.safe7579.address, [initializedTopic, padHex(account, { size: 32 })], start, end),
        logs(ENTRY_POINT, [userOperationTopic, null, padHex(account, { size: 32 })], start, end),
      ]);
      const candidatesByBlock = new Map<bigint, Map<Hex, Hex>>();
      let candidateTransactions = 0;
      function addCandidate(n: bigint, txHash: Hex, blockHash: Hex) {
        txHash = txHash.toLowerCase() as Hex;
        const transactions = candidatesByBlock.get(n) ?? new Map<Hex, Hex>();
        const known = transactions.get(txHash);
        if (known && !same(known, blockHash))
          fail(
            "SMART_HISTORY_REORG",
            "An authority transaction has conflicting block identities.",
            409,
          );
        if (!known) {
          transactions.set(txHash, blockHash);
          candidateTransactions++;
        }
        candidatesByBlock.set(n, transactions);
        if (
          candidatesByBlock.size > limits.history ||
          candidateTransactions > limits.transactions
        )
          fail(
            "SMART_HISTORY_LIMIT",
            "Active account history exceeds the bounded block or transaction trace budget.",
            503,
          );
      }
      for (const event of [
        ...safeEvents,
        ...initializationEvents,
        ...userOperationEvents,
      ]) {
        addCandidate(
          quantity(event.blockNumber),
          event.transactionHash as Hex,
          event.blockHash as Hex,
        );
      }
      if (start <= history.creationBlock)
        addCandidate(
          history.creationBlock,
          history.creationTransaction,
          history.creationHash,
        );
      const events = safeEvents.filter(
        (event) =>
          Array.isArray(event.topics) &&
          [installedTopic, uninstalledTopic].some((t) =>
            same(t, String((event.topics as Hex[])[0])),
          ),
      );
      for (const event of events) {
        if (
          !same(
            (await header(quantity(event.blockNumber))).hash,
            String(event.blockHash),
          )
        )
          fail(
            "SMART_HISTORY_REORG",
            "Module history is no longer canonical.",
            409,
          );
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: MODULE_ABI,
            data: hex(event.data),
            topics: event.topics as [Hex, ...Hex[]],
          });
        } catch {
          fail(
            "SMART_HISTORY_INCOMPLETE",
            "An authority event cannot be decoded.",
          );
        }
        if (
          decoded.args.moduleTypeId !== 1n ||
          !same(decoded.args.module, m.smartSessions.address)
        )
          fail(
            "SMART_MODULE_HISTORY_UNSUPPORTED",
            "The account has unknown validator, executor, fallback, hook or multi-type module history.",
          );
      }
      let created = history.lastBlock >= history.creationBlock;
      for (const n of [...candidatesByBlock.keys()].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const h = await header(n);
        if (
          n === history.lastBlock + 1n &&
          !same(h.parentHash, history.lastHash)
        )
          fail(
            "SMART_HISTORY_REORG",
            "Canonical account history changed during inspection.",
            409,
          );
        const candidateHashes = candidatesByBlock.get(n)!;
        const indexes = new Map(
          h.transactions.map((hash, index) => [hash.toLowerCase(), index]),
        );
        for (const [txHash, blockHash] of candidateHashes)
          if (!same(h.hash, blockHash) || !indexes.has(txHash))
            fail(
              "SMART_HISTORY_REORG",
              "An authority ingress transaction is not in its canonical block.",
              409,
            );
        let frames = 0;
        for (const txHash of [...candidateHashes.keys()].sort(
          (a, b) => indexes.get(a)! - indexes.get(b)!,
        )) {
          const receipt = record(
            await rpc("eth_getTransactionReceipt", [txHash]),
          );
          const tx = record(await rpc("eth_getTransactionByHash", [txHash]));
          if (
            !isWord(tx.hash) ||
            !same(tx.hash, txHash) ||
            !isWord(receipt.transactionHash) ||
            !same(receipt.transactionHash, txHash) ||
            !isWord(tx.blockHash) ||
            !same(tx.blockHash, h.hash) ||
            !isWord(receipt.blockHash) ||
            !same(receipt.blockHash, h.hash) ||
            quantity(tx.blockNumber) !== n ||
            quantity(receipt.blockNumber) !== n ||
            quantity(tx.transactionIndex) !== BigInt(indexes.get(txHash)!) ||
            quantity(receipt.transactionIndex) !==
              BigInt(indexes.get(txHash)!) ||
            quantity(receipt.status) !== 1n ||
            typeof tx.from !== "string" ||
            !isAddress(tx.from) ||
            (tx.to !== null && (typeof tx.to !== "string" || !isAddress(tx.to)))
          )
            fail(
              "SMART_HISTORY_INCOMPLETE",
              "An authority transaction and its successful receipt must match the canonical block.",
              503,
            );
          let traced: unknown;
          try {
            traced = await rpc("debug_traceTransaction", [
              txHash,
              {
                tracer: "callTracer",
                timeout: "10s",
                tracerConfig: { onlyTopCall: false },
              },
            ]);
          } catch {
            fail(
              "SMART_TRACE_REQUIRED",
              "Execution requires complete canonical callTracer history from the configured archive RPC.",
              503,
            );
          }
          if (!traced || typeof traced !== "object" || Array.isArray(traced))
            fail(
              "SMART_HISTORY_INCOMPLETE",
              "Each authority transaction requires a complete call trace.",
              503,
            );
          const root = record(traced);
          if (
            root.error !== undefined ||
            root.type !== (tx.to === null ? "CREATE" : "CALL") ||
            typeof root.from !== "string" ||
            !same(root.from, tx.from) ||
            typeof root.to !== "string" ||
            !same(root.to, String(tx.to ?? receipt.contractAddress)) ||
            !same(hex(root.input), hex(tx.input)) ||
            quantity(root.value) !== quantity(tx.value)
          )
            fail(
              "SMART_HISTORY_INCOMPLETE",
              "The call trace root does not match its canonical transaction and receipt.",
              503,
            );
          function sessionAdministration(data: Hex) {
            const selector = data.slice(0, 10).toLowerCase();
            if (
              !SAFE7579_SESSION_STATEFUL_SELECTORS.includes(selector) &&
              !sessionViewSelectors.has(selector)
            )
              fail(
                "SMART_SESSION_HISTORY_UNSUPPORTED",
                "A successful unrecognized module entry cannot be treated as read-only.",
              );
            let mutated = sessionAdminSelectors.has(selector);
            let initializations:
              | readonly {
                  sessionValidator: Address;
                  sessionValidatorInitData: Hex;
                  salt: Hex;
                }[]
              | undefined;
            try {
              if (selector === selectorOf("onInstall(bytes)")) {
                const decoded = decodeFunctionData({
                  abi: SESSION_MUTATION_ABI,
                  data,
                });
                if (decoded.functionName !== "onInstall")
                  throw new Error("Unexpected initializer");
                if (decoded.args[0] !== "0x") {
                  initializations = decodeAbiParameters(
                    LEGACY_SESSION_PARAMETERS,
                    `0x${decoded.args[0].slice(4)}`,
                  )[0];
                  mutated = true;
                }
              } else {
                let decoded;
                try {
                  decoded = decodeFunctionData({
                    abi: LEGACY_SESSION_SETUP_ABI,
                    data,
                  });
                } catch {
                  /* Another known module selector. */
                }
                if (decoded?.functionName === "enableSessions") {
                  initializations = decoded.args[0];
                  mutated = true;
                } else if (
                  selector ===
                  selectorOf(
                    "validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
                  )
                ) {
                  const validation = decodeFunctionData({
                    abi: SESSION_MUTATION_ABI,
                    data,
                  });
                  if (validation.functionName !== "validateUserOp")
                    throw new Error("Unexpected validation");
                  // ENABLE / UNSAFE_ENABLE can overwrite policies inside validation. The reviewed
                  // owner activation path never uses those modes; they cannot certify an initializer.
                  mutated =
                    validation.args[0].signature.slice(0, 4).toLowerCase() !==
                    "0x00";
                }
              }
            } catch {
              fail(
                "SMART_SESSION_HISTORY_UNSUPPORTED",
                "Session administration history cannot be decoded against the pinned source.",
              );
            }
            if (!mutated) return;
            if (
              initializations &&
              (initializations.length < 1 || initializations.length > 64)
            )
              fail(
                "SMART_SESSION_HISTORY_UNSUPPORTED",
                "Session initialization exceeds the bounded history certificate.",
              );
            const epoch = BigInt(history!.sessionAdministration.epoch) + 1n;
            if (epoch >= 1n << 256n)
              fail(
                "SMART_SESSION_HISTORY_UNSUPPORTED",
                "Session administration epoch exhausted.",
              );
            const permissionIds = initializations?.map((session) =>
              keccak256(
                encodeAbiParameters(
                  [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }],
                  [
                    session.sessionValidator,
                    session.sessionValidatorInitData,
                    session.salt,
                  ],
                ),
              ),
            );
            history!.sessionAdministration = {
              epoch: String(epoch),
              hash: fingerprint({
                previous: history!.sessionAdministration.hash,
                txHash,
                data: data.toLowerCase(),
              }),
              ...(permissionIds
                ? {
                    lastInitialization: { epoch: String(epoch), permissionIds },
                  }
                : {}),
            };
          }
          function visit(value: unknown, depth: number) {
            if (++frames > limits.frames || depth > 128)
              fail(
                "SMART_HISTORY_LIMIT",
                "Account history exceeds the trace complexity budget.",
                503,
              );
            const frame = record(value);
            if (
              typeof frame.type !== "string" ||
              typeof frame.from !== "string" ||
              !isAddress(frame.from) ||
              (frame.calls !== undefined && !Array.isArray(frame.calls))
            )
              fail(
                "SMART_HISTORY_INCOMPLETE",
                "Incomplete call trace frame.",
                503,
              );
            if (frame.error !== undefined) {
              if (typeof frame.error !== "string" || !frame.error)
                fail(
                  "SMART_HISTORY_INCOMPLETE",
                  "Invalid reverted trace frame.",
                  503,
                );
              return;
            }
            const type = frame.type.toUpperCase();
            if (
              ![
                "CALL",
                "STATICCALL",
                "DELEGATECALL",
                "CALLCODE",
                "CREATE",
                "CREATE2",
                "SELFDESTRUCT",
              ].includes(type) ||
              (type !== "SELFDESTRUCT" &&
                (typeof frame.to !== "string" ||
                  !isAddress(frame.to) ||
                  hex(frame.input).length > 2_097_154))
            )
              fail(
                "SMART_HISTORY_INCOMPLETE",
                "Unknown or unbounded call trace frame.",
                503,
              );
            const fromSafe = same(frame.from, account),
              toSafe = typeof frame.to === "string" && same(frame.to, account);
            if (
              fromSafe &&
              type === "CALL" &&
              typeof frame.to === "string" &&
              same(frame.to, m.smartSessions.address)
            )
              sessionAdministration(hex(frame.input));
            if ((type === "CREATE" || type === "CREATE2") && toSafe) {
              if (
                created ||
                type !== "CREATE2" ||
                !same(frame.from, m.factory.address) ||
                !same(txHash, history!.creationTransaction)
              )
                fail(
                  "SMART_CREATION_PROOF_REQUIRED",
                  "Account creation must be the unique reviewed factory CREATE2.",
                );
              created = true;
            }
            if (fromSafe && (type === "SELFDESTRUCT" || type === "CALLCODE"))
              fail(
                "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
                "Unsupported account code lifecycle.",
              );
            if (fromSafe && type === "DELEGATECALL") {
              const target = String(frame.to);
              const launch =
                same(target, m.launchpad.address) &&
                same(txHash, history!.creationTransaction) &&
                prepared !== undefined &&
                same(
                  hex(frame.input),
                  decodeFunctionData({
                    abi: SAFE_SETUP_ABI,
                    data: prepared.initializer,
                  }).args[3],
                );
              if (
                !same(target, m.singleton.address) &&
                !same(target, options.utility.address) &&
                !launch
              )
                fail(
                  "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
                  "An unreviewed owner delegatecall can hide module authority and blocks execution.",
                );
            }
            if (
              fromSafe &&
              type === "CALL" &&
              typeof frame.to === "string" &&
              same(frame.to, m.safe7579.address)
            ) {
              const data = hex(frame.input);
              let decoded;
              try {
                decoded = decodeFunctionData({ abi: MODULE_ABI, data });
              } catch {
                /* Non-mutating or ordinary execution selector. */
              }
              if (
                decoded &&
                [
                  "installModule",
                  "uninstallModule",
                  "initializeAccount",
                  "initializeAccountWithValidators",
                ].includes(decoded.functionName)
              ) {
                if (
                  decoded.functionName === "installModule" ||
                  decoded.functionName === "uninstallModule"
                ) {
                  if (
                    decoded.args[0] !== 1n ||
                    !same(decoded.args[1], m.smartSessions.address)
                  )
                    fail(
                      "SMART_MODULE_HISTORY_UNSUPPORTED",
                      "Unknown or multi-type authority cannot be certified from a selector mapping.",
                    );
                } else if (
                  decoded.functionName === "initializeAccount" ||
                  decoded.functionName === "initializeAccountWithValidators"
                ) {
                  if (
                    decoded.args[0].some(
                      (module) =>
                        module.moduleType !== 1n ||
                        !same(module.module, m.smartSessions.address),
                    )
                  )
                    fail(
                      "SMART_MODULE_HISTORY_UNSUPPORTED",
                      "Initial module authority is unsupported.",
                    );
                }
                history!.authorityHash = fingerprint({
                  previous: history!.authorityHash,
                  txHash,
                  data: data.toLowerCase(),
                });
                history!.lifecycleChanges++;
              }
            }
            if (toSafe && (type === "CALL" || type === "STATICCALL")) {
              let decoded;
              try {
                decoded = decodeFunctionData({
                  abi: SAFE_LIFECYCLE_ABI,
                  data: hex(frame.input),
                });
              } catch {
                /* Ordinary Safe call. */
              }
              if (decoded) {
                if (
                  decoded.functionName === "enableModule" &&
                  !same(decoded.args[0], m.safe7579.address)
                )
                  fail(
                    "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
                    "An alternate Safe module bypasses the reviewed validator.",
                  );
                if (
                  decoded.functionName === "setFallbackHandler" &&
                  !same(decoded.args[0], m.safe7579.address)
                )
                  fail(
                    "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
                    "A different Safe fallback handler breaks complete adapter history.",
                  );
                if (
                  decoded.functionName === "setGuard" &&
                  !same(decoded.args[0], zeroAddress)
                )
                  fail(
                    "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
                    "A Safe guard requires a separate reviewed lifecycle.",
                  );
                history!.authorityHash = fingerprint({
                  previous: history!.authorityHash,
                  txHash,
                  data: hex(frame.input).toLowerCase(),
                });
                history!.lifecycleChanges++;
              }
            }
            for (const child of (frame.calls ?? []) as unknown[])
              visit(child, depth + 1);
          }
          visit(traced, 0);
        }
        history.lastBlock = n;
        history.lastHash = h.hash;
      }
      history.lastBlock = end;
      history.lastHash = (await header(end)).hash;
      if (!created || !same(history.lastHash, snapshot.tag.blockHash))
        fail(
          "SMART_HISTORY_INCOMPLETE",
          "Creation and the requested final snapshot must be covered by complete traces.",
          503,
        );

      await Promise.all([
        m.factory,
        m.singleton,
        m.safe7579,
        m.launchpad,
        m.smartSessions,
        m.entryPoint,
        options.utility,
      ].map(async pin => {
        const code = hex(await snapshot.request("eth_getCode", [pin.address]));
        if (code === "0x" || !same(keccak256(code), pin.runtimeCodeHash))
          fail(
            "SMART_INSPECTION_CODE_MISMATCH",
            "The current stack no longer matches its reviewed code identity.",
          );
      }));

      async function call(
        name:
          | "getValidatorsPaginated"
          | "getExecutorsPaginated"
          | "getActiveHook"
          | "getPrevalidationHook"
          | "getNonce"
          | "entryPoint",
        args: readonly unknown[] = [],
      ): Promise<unknown> {
        const data = encodeFunctionData({
          abi: MODULE_ABI,
          functionName: name,
          args: args as never,
        });
        return decodeFunctionResult({
          abi: MODULE_ABI,
          functionName: name,
          data: hex(
            await snapshot.request("eth_call", [
              { from: account, to: m.safe7579.address, data },
            ]),
          ),
        });
      }
      async function storage(slot: Hex) {
        return storedAddress(
          await snapshot.request("eth_getStorageAt", [
            m.safe7579.address,
            slot,
          ]),
        );
      }
      async function list(slot: 2 | 3) {
        const result: Address[] = [];
        let cursor = SENTINEL;
        for (let page = 0; page < 16; page++) {
          const [entries, next] = (await call(
            slot === 2 ? "getValidatorsPaginated" : "getExecutorsPaginated",
            [cursor, 16n],
          )) as readonly [readonly Address[], Address];
          if (
            entries.length > 16 ||
            (!same(next, SENTINEL) &&
              (entries.length !== 16 || !same(next, entries.at(-1)!)))
          )
            fail("SMART_MODULE_LIST_INVALID", "Incomplete module pagination.");
          for (const entry of entries) {
            if (
              BigInt(entry) <= 1n ||
              result.some((e) => same(e, entry)) ||
              !same(
                await storage(safe7579ListSlot(account, cursor, slot)),
                entry,
              )
            )
              fail(
                "SMART_MODULE_LIST_INVALID",
                "Module storage and pagination disagree or contain a cycle.",
              );
            result.push(getAddress(entry));
            cursor = entry;
          }
          if (same(next, SENTINEL)) {
            if (
              !same(
                await storage(safe7579ListSlot(account, cursor, slot)),
                SENTINEL,
              )
            )
              fail(
                "SMART_MODULE_LIST_INVALID",
                "Module list is uninitialized or has hidden entries.",
              );
            return result;
          }
        }
        return fail(
          "SMART_MODULE_LIST_INVALID",
          "Module enumeration exceeds the supported bound.",
        );
      }
      const [validators, executors] = await Promise.all([list(2), list(3)]);
      if (
        validators.length !== 1 ||
        !same(validators[0]!, m.smartSessions.address) ||
        executors.length !== 0
      )
        fail(
          "SMART_MODULE_CONFIGURATION_UNSUPPORTED",
          "Only the reviewed SmartSession validator and no executors may be installed.",
        );
      const [hooks, hookStorage] = await Promise.all([
        Promise.all([call("getActiveHook"), call("getPrevalidationHook", [9n]), call("getPrevalidationHook", [8n])]) as Promise<Address[]>,
        Promise.all([5, 7, 8].map(slot => storage(safe7579MappingSlot(account, slot)))),
      ]);
      for (let i = 0; i < 3; i++)
        if (
          !same(
            hooks[i]!,
            hookStorage[i]!,
          ) ||
          !same(hooks[i]!, zeroAddress)
        )
          fail(
            "SMART_MODULE_CONFIGURATION_UNSUPPORTED",
            "Global and prevalidation hooks must be absent.",
          );
      const [registryAddress, adapterEntryPoint] = await Promise.all([storage(safe7579MappingSlot(account, 0)), call("entryPoint")]);
      if (!same(registryAddress, zeroAddress))
        fail(
          "SMART_REGISTRY_STATE_UNSUPPORTED",
          "This source revision does not enforce or configure registry attesters; unexpected registry storage is unsupported.",
        );
      if (!same(String(adapterEntryPoint), ENTRY_POINT))
        fail(
          "SMART_ENTRYPOINT_MISMATCH",
          "The adapter EntryPoint differs from its reviewed immutable source.",
        );
      const nonce = (await call("getNonce", [
        account,
        m.smartSessions.address,
      ])) as bigint;
      const expectedKey = BigInt(m.smartSessions.address) << 32n;
      const directNonce = decodeFunctionResult({
        abi: ENTRY_ABI,
        functionName: "getNonce",
        data: hex(
          await snapshot.request("eth_call", [
            {
              to: ENTRY_POINT,
              data: encodeFunctionData({
                abi: ENTRY_ABI,
                functionName: "getNonce",
                args: [account, expectedKey],
              }),
            },
          ]),
        ),
      });
      if (nonce !== directNonce || nonce >> 64n !== expectedKey)
        fail(
          "SMART_NONCE_LAYOUT_MISMATCH",
          "The validator/lane/sequence nonce does not match the pinned EntryPoint state.",
        );
      const sessions = await options.inspectSessions({
        account,
        manifest: m,
        snapshot,
      });
      if (
        !isWord(sessions.stateHash) ||
        sessions.arbitrarySigningDisabled !== true ||
        sessions.wildcardExecutionDisabled !== true ||
        sessions.gasBudgetEnforced !== true ||
        !Array.isArray(sessions.permissionIds) ||
        sessions.permissionIds.length > 64 ||
        !sessions.permissionIds.every(isWord) ||
        new Set(sessions.permissionIds.map((p) => p.toLowerCase())).size !==
          sessions.permissionIds.length
      )
        fail(
          "SMART_SESSION_CONFIGURATION_UNSUPPORTED",
          "Every installed permission must have exact signing, action and gas-budget proof.",
        );
      const latest = record(
        await rpc("eth_getBlockByNumber", [toHex(end), false]),
      );
      if (!isWord(latest.hash) || !same(latest.hash, snapshot.tag.blockHash))
        fail(
          "SMART_HISTORY_REORG",
          "The inspected snapshot is no longer canonical.",
          409,
        );
      const layout = {
        inspector: SAFE7579_INSPECTOR_ID,
        account: account.toLowerCase(),
        manifestRevision: m.revision,
        validators: validators.map((a) => a.toLowerCase()),
        executors: [],
        hooks: [],
        fallbacks: [],
        prevalidationHooks: [],
        registry: {
          enforcement: "disabled-in-source",
          address: zeroAddress,
          attesters: [],
          threshold: 0,
        },
        utility: {
          address: options.utility.address.toLowerCase(),
          runtimeCodeHash: options.utility.runtimeCodeHash,
        },
        authorityHistoryHash: history.authorityHash,
      };
      if (options.checkpointStore) {
        const retained: Safe7579HistoryCheckpoint = {
          schemaVersion: 2,
          key,
          creationBlock: String(history.creationBlock),
          creationHash: history.creationHash,
          creationTransaction: history.creationTransaction,
          initializerHash: history.initializerHash,
          lastBlock: String(history.lastBlock),
          lastHash: history.lastHash,
          authorityHash: history.authorityHash,
          lifecycleChanges: history.lifecycleChanges,
          sessionAdministration: structuredClone(history.sessionAdministration),
        };
        await options.checkpointStore.put(retained);
      }
      cache.delete(key);
      cache.set(key, structuredClone(history));
      while (cache.size > limits.cache)
        cache.delete(cache.keys().next().value!);
      return {
        complete: true,
        arbitrarySigningDisabled: true,
        wildcardExecutionDisabled: true,
        stateHash: fingerprint(layout),
        details: {
          ...layout,
          sessionAdministration: structuredClone(history.sessionAdministration),
          provenance: {
            creationBlock: String(history.creationBlock),
            creationTransaction: history.creationTransaction,
            initializerHash: history.initializerHash,
            throughBlock: String(end),
            throughBlockHash: snapshot.tag.blockHash,
            lifecycleChanges: history.lifecycleChanges,
            method:
              "canonical-factory-creation-and-complete-authority-ingress-traces",
          },
          nonce: {
            value: String(nonce),
            validator: m.smartSessions.address,
            lane: "0",
            sequence: String(nonce & ((1n << 64n) - 1n)),
            layout: "validator20/lane4/sequence8",
            signatureEnvelope:
              "USE: 0x00 || permissionId32 || sessionValidatorSignature",
          },
          sessions: {
            configurationHash: sessions.stateHash,
            permissionIds: sessions.permissionIds,
            gasBudgetEnforced: true,
          },
        },
      };
    },
  };
}
