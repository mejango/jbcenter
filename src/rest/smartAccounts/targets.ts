import { readFile } from "node:fs/promises";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type {
  CodeRecord,
  CodeSpan,
  DeploymentRecord,
} from "../contracts/types.js";
import { RestError, type RestRpc } from "../core.js";
import { address, exactObject, integer } from "../protocol/abi.js";
import {
  cloneImplementation,
  rpcHex,
  verifyRuntime,
} from "../protocol/code.js";
import type {
  createProtocolReadService,
  ProtocolCatalog,
} from "../protocol/index.js";
import { UserOperationChain } from "../userOperations/chain.js";
import { uoCanonical, uoObject } from "../userOperations/codec.js";
import type { ReviewedSessionAsset, ReviewedSessionTarget } from "./policy.js";
import type { SessionPolicyInput, SmartAccountBinding } from "./types.js";

export const V6_SESSION_TARGET_CONTRACTS = Object.freeze({
  "v6-pay": "@bananapus/core-v6:src/JBMultiTerminal.sol:JBMultiTerminal",
  "v6-project-uri": "@bananapus/core-v6:src/JBController.sol:JBController",
});
const chains = [1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420] as const;
const mainnets = new Set<number>([1, 10, 8453, 42161]);
export const V6_NATIVE_SESSION_ASSETS: readonly ReviewedSessionAsset[] =
  Object.freeze(
    chains.map((chainId) =>
      Object.freeze({
        chainId,
        address: "0x000000000000000000000000000000000000eeee" as Address,
        assetIdentity: mainnets.has(chainId) ? "ETH" : "ETH:testnet",
        decimals: 18,
        reviewId: `v6-native-eth-18:${chainId}`,
      }),
    ),
  );
export interface SessionTargetSourceEvidence {
  contractId: string;
  catalogCodeId: string;
  code: CodeRecord;
  linkage?: readonly {
    sourcePath: string;
    libraryName: string;
    address: Address;
    runtimeReferences: readonly CodeSpan[];
    code: CodeRecord;
    provenance: {
      contractId: string;
      catalogCodeId: string;
      sourceInputIdentitySha256: string;
      deploymentPaths: readonly string[];
      deployments: readonly {
        chainId: number;
        artifactPath: string;
        artifactSha256: string;
      }[];
      compilerCreationSha256: string;
    };
  }[];
}
export interface SessionTargetResolverOptions {
  catalog: ProtocolCatalog;
  protocol: Pick<ReturnType<typeof createProtocolReadService>, "resolve">;
  rpc: RestRpc;
  /** Already source-reviewed immutable ERC20 implementations; no proxy or arbitrary token discovery. */
  targets?: readonly ReviewedSessionTarget[];
  assets?: readonly ReviewedSessionAsset[];
  /** Trusted supplemental compiler evidence, never an HTTP parameter. Defaults to checked local artifacts. */
  sourceEvidence?: readonly SessionTargetSourceEvidence[];
}
function fail(code: string, message: string, status = 422): never {
  throw new RestError(status, code, message);
}
const hash = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
async function withinBudget<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new RestError(
          499,
          "SMART_TARGET_CANCELLED",
          "Target verification was cancelled.",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    fail(
      "SMART_SESSION_POLICY_INVALID",
      "Use a bounded exact allocation identifier.",
      400,
    );
  return value;
}
async function localSourceEvidence(): Promise<
  readonly SessionTargetSourceEvidence[]
> {
  let text: string;
  try {
    text = await readFile(
      new URL("./targets-evidence/manifest.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (uoObject(error) && error.code === "ENOENT") return [];
    throw error;
  }
  if (Buffer.byteLength(text) > 8_388_608)
    fail(
      "SMART_TARGET_EVIDENCE_INVALID",
      "The local source evidence exceeds its bound.",
      500,
    );
  const manifest: unknown = JSON.parse(text);
  if (
    !uoObject(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.protocolVersion !== 6 ||
    !Array.isArray(manifest.records) ||
    manifest.records.length > 16
  )
    fail(
      "SMART_TARGET_EVIDENCE_INVALID",
      "The local source evidence manifest is invalid.",
      500,
    );
  return manifest.records as SessionTargetSourceEvidence[];
}
function supplementFor(
  records: readonly SessionTargetSourceEvidence[],
  contractId: string,
  deployment: DeploymentRecord,
  original: CodeRecord,
): SessionTargetSourceEvidence | undefined {
  const matches = records.filter(
    (item) =>
      item.contractId === contractId &&
      item.catalogCodeId === deployment.codeId,
  );
  if (matches.length > 1)
    fail(
      "SMART_TARGET_EVIDENCE_INVALID",
      "Duplicate supplemental runtime identities are ambiguous.",
      500,
    );
  const code = matches[0]?.code;
  if (!code) return undefined;
  if (
    code.id !== original.id ||
    code.runtimeTemplate !== original.runtimeTemplate ||
    code.runtimeTemplateKeccak256 !== original.runtimeTemplateKeccak256 ||
    code.runtimeTemplateSha256 !== original.runtimeTemplateSha256 ||
    code.runtimeTemplateByteLength !== original.runtimeTemplateByteLength ||
    code.creationSha256 !== original.creationSha256 ||
    code.immutableReferences === null ||
    code.linkReferences === null ||
    !code.compilerEvidence ||
    code.compilerEvidence.sourceInputIdentitySha256 !==
      deployment.compilerInputIdentitySha256 ||
    !code.compilerEvidence.deploymentPaths?.includes(deployment.artifactPath)
  )
    fail(
      "SMART_TARGET_EVIDENCE_INVALID",
      "Supplemental compiler evidence does not bind this exact official deployment.",
      500,
    );
  return matches[0];
}
/** Performs no network work at construction. Target authority is derived anew at the binding's canonical block. */
export function createSessionTargetResolver(
  options: SessionTargetResolverOptions,
) {
  if (
    options.catalog.data.protocolVersion !== 6 ||
    options.catalog.data.schemaVersion !== 1
  )
    fail(
      "SMART_TARGET_CATALOG_VERSION",
      "Session targets require the verified V6 catalog.",
      500,
    );
  const targets = (options.targets ?? []).map((target) => {
    if (
      !chains.includes(target.chainId as (typeof chains)[number]) ||
      target.kind !== "erc20-exact-transfer" ||
      !hash(target.runtimeCodeHash) ||
      typeof target.reviewId !== "string" ||
      target.reviewId.length < 1 ||
      target.reviewId.length > 400
    )
      fail(
        "SMART_TARGET_CONFIGURATION_INVALID",
        "Only bounded, pre-reviewed immutable ERC20 targets may supplement the V6 catalog.",
        500,
      );
    return Object.freeze({
      ...target,
      address: address(target.address, "reviewed token", true),
    });
  });
  if (
    targets.length > 128 ||
    new Set(targets.map((t) => `${t.chainId}:${t.address.toLowerCase()}`))
      .size !== targets.length
  )
    fail(
      "SMART_TARGET_CONFIGURATION_INVALID",
      "Reviewed target configuration is duplicated or exceeds its bound.",
      500,
    );
  const assets = [
    ...V6_NATIVE_SESSION_ASSETS,
    ...(options.assets ?? []).map((asset) => {
      if (
        !chains.includes(asset.chainId as (typeof chains)[number]) ||
        !Number.isSafeInteger(asset.decimals) ||
        asset.decimals < 0 ||
        asset.decimals > 255 ||
        typeof asset.assetIdentity !== "string" ||
        asset.assetIdentity.length < 1 ||
        asset.assetIdentity.length > 128 ||
        typeof asset.reviewId !== "string" ||
        asset.reviewId.length < 1 ||
        asset.reviewId.length > 400
      )
        fail(
          "SMART_TARGET_CONFIGURATION_INVALID",
          "Reviewed asset identity or units are invalid.",
          500,
        );
      return Object.freeze({
        ...asset,
        address: address(asset.address, "reviewed asset", true),
      });
    }),
  ];
  if (
    assets.length > 136 ||
    new Set(assets.map((a) => `${a.chainId}:${a.address.toLowerCase()}`))
      .size !== assets.length
  )
    fail(
      "SMART_TARGET_CONFIGURATION_INVALID",
      "Reviewed asset identities are duplicated or exceed their bound.",
      500,
    );
  let sources: Promise<readonly SessionTargetSourceEvidence[]> | undefined;
  return {
    assets: Object.freeze(assets),
    async resolve(
      binding: SmartAccountBinding,
      input: Pick<SessionPolicyInput, "actions" | "allocations">,
      signal?: AbortSignal,
    ): Promise<ReviewedSessionTarget[]> {
      const evidence = binding.state.evidence;
      if (
        !chains.includes(binding.wallet.chainId as (typeof chains)[number]) ||
        evidence.chainId !== binding.wallet.chainId ||
        evidence.source !== "onchain" ||
        !hash(evidence.blockHash) ||
        !/^(0|[1-9][0-9]{0,77})$/.test(evidence.blockNumber) ||
        !/^(0|[1-9][0-9]{0,19})$/.test(evidence.timestamp)
      )
        fail(
          "SMART_TARGET_BINDING_INVALID",
          "Targets need an exact canonical V6 account review block.",
          400,
        );
      if (
        !input ||
        !Array.isArray(input.actions) ||
        input.actions.length < 1 ||
        input.actions.length > 16 ||
        !Array.isArray(input.allocations) ||
        input.allocations.length > 16
      )
        fail(
          "SMART_SESSION_POLICY_INVALID",
          "Use 1–16 exact actions and at most sixteen allocation groups.",
          400,
        );
      const allocations = new Map<
        string,
        { chainId: number; asset: Address }
      >();
      const groupIds = new Set<string>();
      for (const group of input.allocations) {
        exactObject(group, ["id", "total", "allocations"], "allocation group");
        const id = identifier(group.id);
        if (
          groupIds.has(id) ||
          integer(group.total, "allocation total") === 0n ||
          !Array.isArray(group.allocations) ||
          group.allocations.length < 1 ||
          group.allocations.length > 8
        )
          fail(
            "SMART_SESSION_POLICY_INVALID",
            "Allocation groups need unique IDs, positive totals and 1–8 explicit allocations.",
            400,
          );
        groupIds.add(id);
        for (const item of group.allocations) {
          exactObject(item, ["id", "chainId", "asset", "limit"], "allocation");
          const aid = identifier(item.id),
            asset = address(item.asset, "asset", true);
          if (
            allocations.has(aid) ||
            !chains.includes(item.chainId as (typeof chains)[number]) ||
            integer(item.limit, "allocation limit") === 0n
          )
            fail(
              "SMART_SESSION_POLICY_INVALID",
              "Each allocation needs a unique ID, V6 chain and positive limit.",
              400,
            );
          if (
            !assets.some(
              (a) => a.chainId === item.chainId && same(a.address, asset),
            )
          )
            fail(
              "SMART_ASSET_UNITS_UNVERIFIED",
              "Every allocated asset needs immutable host-reviewed identity and units.",
            );
          allocations.set(aid, { chainId: item.chainId, asset });
        }
      }
      const requested: {
        kind: "v6-pay" | "v6-project-uri" | "erc20-transfer";
        address: Address;
        projectId?: string;
        reviewed?: ReviewedSessionTarget;
      }[] = [];
      const coordinates = new Set<string>();
      for (const action of input.actions) {
        if (
          !action ||
          !["v6-pay", "v6-project-uri", "erc20-transfer"].includes(action.kind)
        )
          fail(
            "SMART_SESSION_POLICY_INVALID",
            "Only closed V6 actions and pre-reviewed ERC20 transfers are supported.",
            400,
          );
        let target: Address;
        let projectId: string | undefined;
        let reviewed: ReviewedSessionTarget | undefined;
        if (action.kind === "v6-project-uri") {
          exactObject(
            action,
            ["kind", "controller", "projectId"],
            "project URI action",
          );
          target = address(action.controller, "controller", true);
          projectId = integer(action.projectId, "project ID").toString();
        } else {
          exactObject(
            action,
            action.kind === "v6-pay"
              ? [
                  "kind",
                  "allocationId",
                  "terminal",
                  "projectId",
                  "beneficiary",
                  "perCallLimit",
                  "totalLimit",
                  "minReturnedTokens",
                ]
              : [
                  "kind",
                  "allocationId",
                  "beneficiary",
                  "perCallLimit",
                  "totalLimit",
                ],
            "spending action",
          );
          const allocation = allocations.get(identifier(action.allocationId));
          if (!allocation || allocation.chainId !== binding.wallet.chainId)
            fail(
              "SMART_SESSION_POLICY_INVALID",
              "The action allocation must use the bound account's chain.",
              400,
            );
          address(action.beneficiary, "beneficiary", true);
          if (
            integer(action.perCallLimit, "per-call limit") === 0n ||
            integer(action.totalLimit, "total limit") === 0n
          )
            fail(
              "SMART_SESSION_POLICY_INVALID",
              "Spending limits must be positive.",
              400,
            );
          if (action.kind === "v6-pay") {
            target = address(action.terminal, "terminal", true);
            projectId = integer(action.projectId, "project ID").toString();
            integer(action.minReturnedTokens, "minimum return");
          } else {
            target = allocation.asset;
            reviewed = targets.find(
              (t) =>
                t.chainId === binding.wallet.chainId && same(t.address, target),
            );
            if (!reviewed)
              fail(
                "SMART_TARGET_REVIEW_REQUIRED",
                "ERC20 execution requires an immutable source-reviewed token target.",
              );
          }
        }
        if (projectId === "0")
          fail(
            "SMART_SESSION_POLICY_INVALID",
            "V6 project IDs must be positive.",
            400,
          );
        const coordinate = `${action.kind}:${target.toLowerCase()}`;
        if (coordinates.has(coordinate) || same(target, binding.wallet.address))
          fail(
            "SMART_SESSION_POLICY_INVALID",
            "Duplicate target actions and account self-calls are forbidden.",
            400,
          );
        coordinates.add(coordinate);
        requested.push({
          kind: action.kind,
          address: target,
          ...(projectId ? { projectId } : {}),
          ...(reviewed ? { reviewed } : {}),
        });
      }
      // Validate catalog identity and exact published addresses before any RPC, including canonical-block reads.
      const prepared = requested.map((item) => {
        if (item.kind === "erc20-transfer")
          return { ...item, deployment: undefined, contractId: undefined };
        const contractId = V6_SESSION_TARGET_CONTRACTS[item.kind];
        const record = options.catalog.get(contractId);
        const packageInfo = options.catalog.data.packages.find(
          (p) => p.id === record.packageId,
        );
        if (
          record.id !== contractId ||
          record.packageId !== "@bananapus/core-v6" ||
          record.category !== "contract" ||
          !record.executable ||
          packageInfo?.repositoryUrl !==
            "https://github.com/Bananapus/nana-core-v6"
        )
          fail(
            "SMART_TARGET_CATALOG_VERSION",
            "The requested action does not resolve to the pinned executable V6 core source.",
          );
        const deployments =
          record.deployments
            .find(
              (d) =>
                d.chainId === binding.wallet.chainId &&
                d.status === "published",
            )
            ?.instances.filter((d) => same(d.address, item.address)) ?? [];
        if (
          deployments.length !== 1 ||
          !deployments[0]!.sourceRef.startsWith("npm:@bananapus/core-v6@")
        )
          fail(
            "SMART_TARGET_NOT_V6",
            "The target is not this chain's exact official V6 contract deployment.",
          );
        return { ...item, contractId, deployment: deployments[0]! };
      });
      const deadline = AbortSignal.timeout(60_000);
      const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const chain = new UserOperationChain(options.rpc, { signal: active });
      await chain.canonical(evidence);
      const result: ReviewedSessionTarget[] = [];
      for (const item of prepared) {
        let template: CodeRecord | undefined;
        let supplemental: SessionTargetSourceEvidence | undefined;
        if (item.deployment && item.contractId) {
          const resolved = await withinBudget(
            options.protocol.resolve(
              {
                chainId: binding.wallet.chainId,
                contractId: item.contractId,
                address: item.address,
                projectId: item.projectId!,
                blockNumber: evidence.blockNumber,
              },
              active,
            ),
            active,
          );
          const provenance = resolved.provenance,
            publication = provenance.publication,
            runtime = provenance.runtime,
            context = provenance.projectContext;
          if (
            resolved.chainId !== binding.wallet.chainId ||
            resolved.contractId !== item.contractId ||
            !same(resolved.address, item.address) ||
            resolved.abiHash !== item.deployment.abiHash ||
            resolved.evidence.length !== 1 ||
            uoCanonical(resolved.evidence[0]) !== uoCanonical(evidence) ||
            provenance.kind !== "published-deployment" ||
            !uoObject(publication) ||
            publication.codeId !== item.deployment.codeId ||
            publication.artifactSha256 !== item.deployment.artifactSha256 ||
            !uoObject(runtime) ||
            !hash(runtime.runtimeCodeHash) ||
            !uoObject(context) ||
            context.projectId !== item.projectId ||
            (item.kind === "v6-pay"
              ? context.terminalAssociationChecked !== true
              : context.controllerAssociationChecked !== true)
          )
            fail(
              "SMART_TARGET_PROVENANCE_MISMATCH",
              "The resolved source, project association or canonical block differs from the reviewed target.",
            );
          template = options.catalog.code(item.deployment.codeId);
          if (
            provenance.runtimeVerified !== true ||
            ![
              "exact-runtime-template",
              "compiler-template-with-observed-immutables",
            ].includes(String(runtime.mode))
          ) {
            sources ??= options.sourceEvidence
              ? Promise.resolve(options.sourceEvidence)
              : localSourceEvidence();
            supplemental = supplementFor(
              await sources,
              item.contractId,
              item.deployment,
              template,
            );
            template = supplemental?.code;
            if (!template)
              fail(
                "SMART_TARGET_SOURCE_UNVERIFIED",
                "The official V6 address lacks matching compiler source/immutable proof; address-only provenance cannot authorize a session.",
              );
          }
          const code = rpcHex(
            await chain.request(binding.wallet.chainId, "eth_getCode", [
              item.address,
              chain.tag(evidence),
            ]),
            "target runtime",
            49_152,
          );
          if (template.linkReferences?.length) {
            const links = supplemental?.linkage;
            if (!links || links.length > 8)
              fail(
                "SMART_TARGET_LINKAGE_UNVERIFIED",
                "Compiler-linked targets require complete fixed library source evidence.",
              );
            const declared = template.linkReferences
              .map((span) => `${span.start}:${span.length}`)
              .sort();
            const supplied = links
              .flatMap((link) =>
                link.runtimeReferences.map(
                  (span) => `${span.start}:${span.length}`,
                ),
              )
              .sort();
            if (
              uoCanonical(declared) !== uoCanonical(supplied) ||
              new Set(supplied).size !== supplied.length
            )
              fail(
                "SMART_TARGET_LINKAGE_UNVERIFIED",
                "Library linkage does not cover exactly the compiler-declared locations.",
              );
            for (const link of links) {
              const library = options.catalog.get(link.provenance.contractId);
              const deployment = library.deployments
                .find(
                  (d) =>
                    d.chainId === binding.wallet.chainId &&
                    d.status === "published",
                )
                ?.instances.find((d) => same(d.address, link.address));
              const published = link.provenance.deployments.find(
                (d) => d.chainId === binding.wallet.chainId,
              );
              if (
                library.category !== "library" ||
                library.packageId !== "@bananapus/core-v6" ||
                library.name !== link.libraryName ||
                !link.sourcePath.endsWith(library.sourcePath) ||
                !deployment ||
                deployment.codeId !== link.provenance.catalogCodeId ||
                deployment.compilerInputIdentitySha256 !==
                  link.provenance.sourceInputIdentitySha256 ||
                !link.provenance.deploymentPaths.includes(
                  deployment.artifactPath,
                ) ||
                published?.artifactPath !== deployment.artifactPath ||
                published.artifactSha256 !== deployment.artifactSha256 ||
                link.provenance.compilerCreationSha256 !==
                  options.catalog.code(deployment.codeId).creationSha256 ||
                link.code.immutableReferences?.length !== 0 ||
                link.code.linkReferences?.length !== 0
              )
                fail(
                  "SMART_TARGET_LINKAGE_UNVERIFIED",
                  "The initialized library runtime lacks exact official source and deployment identity.",
                );
              for (const span of link.runtimeReferences) {
                if (
                  !Number.isSafeInteger(span.start) ||
                  span.start < 0 ||
                  span.length !== 20 ||
                  !same(
                    `0x${template.runtimeTemplate.slice(2 + span.start * 2, 2 + (span.start + span.length) * 2)}`,
                    link.address,
                  )
                )
                  fail(
                    "SMART_TARGET_LINKAGE_UNVERIFIED",
                    "The compiler link does not contain its fixed published library address.",
                  );
                if (
                  template.immutableReferences?.some(
                    (immutable) =>
                      immutable.start < span.start + span.length &&
                      span.start < immutable.start + immutable.length,
                  )
                )
                  fail(
                    "SMART_TARGET_LINKAGE_UNVERIFIED",
                    "Library addresses must never be hidden by immutable masking.",
                  );
              }
              const libraryCode = rpcHex(
                await chain.request(binding.wallet.chainId, "eth_getCode", [
                  link.address,
                  chain.tag(evidence),
                ]),
                "initialized library runtime",
                49_152,
              );
              const proof = verifyRuntime(libraryCode, link.code);
              if (proof.mode !== "exact-runtime-template")
                fail(
                  "SMART_TARGET_LINKAGE_UNVERIFIED",
                  "Libraries require exact constructor-produced runtimes without masks.",
                );
            }
            // All compiler references are now resolved to fixed, independently verified libraries.
            // Their address bytes remain part of the full runtime comparison; none are masked.
            template = { ...template, linkReferences: [] };
          }
          const proof = verifyRuntime(code, template);
          if (
            !same(proof.runtimeCodeHash, runtime.runtimeCodeHash) ||
            cloneImplementation(code)
          )
            fail(
              "SMART_TARGET_PROVENANCE_MISMATCH",
              "The target runtime differs from its independent source resolution.",
            );
          result.push({
            chainId: binding.wallet.chainId,
            address: item.address,
            kind:
              item.kind === "v6-pay" ? "v6-core-terminal" : "v6-controller-uri",
            runtimeCodeHash: proof.runtimeCodeHash,
            reviewId: `v6-source:${keccak256(stringToHex(uoCanonical({ catalog: options.catalog.data.generation.contentHash, contractId: item.contractId, deployment: item.deployment.artifactSha256, template: template.id, proof })))}`,
          });
        } else {
          const code = rpcHex(
            await chain.request(binding.wallet.chainId, "eth_getCode", [
              item.address,
              chain.tag(evidence),
            ]),
            "reviewed token runtime",
            49_152,
          );
          if (
            code === "0x" ||
            cloneImplementation(code) ||
            !same(keccak256(code), item.reviewed!.runtimeCodeHash)
          )
            fail(
              "SMART_TARGET_RUNTIME_CHANGED",
              "The immutable reviewed token runtime is absent or changed.",
            );
          result.push({ ...item.reviewed! });
        }
      }
      await chain.canonical(evidence);
      chain.check();
      return result;
    },
  };
}
