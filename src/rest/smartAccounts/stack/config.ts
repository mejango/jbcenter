import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { RestError } from "../../core.js";
import {
  createLegacySessionCompiler,
  LEGACY_COMPILER_RUNTIME_HASHES,
  type SessionCompilerStack,
} from "../compiler.js";
import { fingerprint } from "../service.js";
import type { ContractPin, SmartAccountManifest } from "../types.js";
import { currentPimlicoGuard, currentPimlicoPaymaster } from "./current-pimlico/config.js";
import {
  CURRENT_PIMLICO_GUARD_MANIFEST_SHA256,
  CURRENT_PIMLICO_GUARD_RUNTIME_HASH,
  CURRENT_PIMLICO_PAYMASTER_MANIFEST_SHA256,
  type SessionGuardVersion,
  type SmartAccountPaymasterProfile,
} from "./current-pimlico/pins.js";

export const SMART_ACCOUNT_STACK_MANIFEST_SHA256 =
  "1924517cd7b1dfec32dc73ae62b7bf8919da1a1c44b1deeae0d5307d223235ff";
type Source = {
  repo?: string;
  repository?: string;
  commit?: string;
  sha256?: string;
  artifactSha256?: string;
  compilerArtifactSha256?: string;
};
type Component = {
  path: string;
  fileSha256: string;
  address: Address | null;
  runtimeCodeHash: Hex;
  source: Source;
  chainIds: number[];
};
type Manifest = {
  schemaVersion: number;
  chainIds: number[];
  components: Record<string, Component>;
};
function fail(message: string): never {
  throw new RestError(500, "SMART_STACK_CONFIGURATION_INVALID", message);
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let loaded: Promise<Manifest> | undefined;
async function checkedManifest(): Promise<Manifest> {
  const bytes = await readFile(new URL("./manifest.json", import.meta.url));
  if (sha(bytes) !== SMART_ACCOUNT_STACK_MANIFEST_SHA256)
    fail("The deployment manifest differs from its reviewed content hash.");
  const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.chainIds) ||
    manifest.chainIds.length !== 8 ||
    !manifest.components
  )
    fail("The stack manifest schema is incomplete.");
  for (const [name, component] of Object.entries(manifest.components)) {
    if (
      component.path !== `artifacts/${name}.json` ||
      !/^[A-Za-z0-9]+$/.test(name)
    )
      fail("An artifact path leaves its reviewed directory.");
    const artifactBytes = await readFile(
      new URL(`./${component.path}`, import.meta.url),
    );
    if (
      artifactBytes.length > 2_000_000 ||
      sha(artifactBytes) !== component.fileSha256
    )
      fail("A stack artifact differs from its reviewed file hash.");
    const artifact = JSON.parse(artifactBytes.toString("utf8")) as {
      contractName: string;
      deployedBytecode?: Hex;
      deployedRuntimeBytecode?: Hex;
      runtimeCodeHash: Hex;
      source: Source;
    };
    const runtime =
      artifact.deployedRuntimeBytecode ?? artifact.deployedBytecode;
    if (
      artifact.contractName !== name ||
      typeof runtime !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtime) ||
      keccak256(runtime) !== component.runtimeCodeHash ||
      artifact.runtimeCodeHash !== component.runtimeCodeHash ||
      fingerprint(artifact.source) !== fingerprint(component.source)
    )
      fail("The stack ABI/runtime/source references are inconsistent.");
  }
  return manifest;
}
function pin(component: Component, override?: Address): ContractPin {
  const address = override ?? component.address;
  if (!address || !isAddress(address) || BigInt(address) === 0n)
    fail(
      "A deployed component address is required; template addresses are never invented.",
    );
  const source = component.source;
  const repository = source.repo ?? source.repository;
  const artifactSha256 = source.artifactSha256 ?? source.compilerArtifactSha256;
  if (!repository || !artifactSha256 || !/^[0-9a-f]{64}$/.test(artifactSha256))
    fail("A component has no exact source artifact identity.");
  const identity = source.commit
    ? { repository, commit: source.commit, artifactSha256 }
    : { repository, contentSha256: source.sha256!, artifactSha256 };
  if (
    (!source.commit &&
      (repository !== "juicebox-center" ||
        !/^[0-9a-f]{64}$/.test(source.sha256 ?? ""))) ||
    (source.commit && !/^[0-9a-f]{40}$/.test(source.commit))
  )
    fail(
      "A source pin must identify its actual commit or exact local source content.",
    );
  return {
    address: getAddress(address),
    runtimeCodeHash: component.runtimeCodeHash,
    source: identity,
  };
}

/** Server-owned configuration only. RPC verification of every configured deployment remains mandatory. */
export async function createConfiguredSmartAccountStack(input: {
  chainId: number;
  paymasterProfile?: SmartAccountPaymasterProfile;
  sessionGuard?: { address: Address; runtimeCodeHash: Hex; version?: SessionGuardVersion };
}) {
  loaded ??= checkedManifest().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  const data = await loaded;
  if (!data.chainIds.includes(input.chainId))
    throw new RestError(
      422,
      "SMART_STACK_CHAIN_UNSUPPORTED",
      "This chain has no reviewed deployment stack.",
    );
  const component = (name: string) => {
    const c = data.components[name];
    if (!c || !c.chainIds.includes(input.chainId))
      fail(`The ${name} deployment is not evidenced on the selected chain.`);
    return c;
  };
  const entryPoint = {
    ...pin(component("EntryPoint")),
    version: "0.7" as const,
  };
  const safe7579 = pin(component("Safe7579"));
  const smartSessions = {
    ...pin(component("SmartSession")),
    generation: "legacy-validator" as const,
  };
  const sessionValidator = pin(component("OwnableValidator"));
  const timeFrame = pin(component("TimeFramePolicy")),
    universalAction = pin(component("UniActionPolicy")),
    valueLimit = pin(component("ValueLimitPolicy"));
  const paymasterProfile = input.paymasterProfile ?? "pimlico-v7-legacy-mode";
  const guardVersion = input.sessionGuard?.version ?? "legacy-v1";
  if (!["pimlico-v7-legacy-mode", "pimlico-v7-current-flags"].includes(paymasterProfile) ||
      !["legacy-v1", "current-v2"].includes(guardVersion) ||
      (input.sessionGuard && (guardVersion === "current-v2") !== (paymasterProfile === "pimlico-v7-current-flags")))
    fail("The guard and paymaster must select the same reviewed deployment profile.");
  let sessionGuard: ContractPin | undefined;
  if (input.sessionGuard) {
    if (guardVersion === "current-v2") {
      if (input.sessionGuard.runtimeCodeHash.toLowerCase() !== CURRENT_PIMLICO_GUARD_RUNTIME_HASH)
        fail("The current guard deployment must match its exact reviewed source runtime.");
      sessionGuard = await currentPimlicoGuard(input.sessionGuard.address);
    } else {
      const c = data.components.CenterSessionGuard;
      if (
        !c ||
        input.sessionGuard.runtimeCodeHash.toLowerCase() !== c.runtimeCodeHash ||
        c.runtimeCodeHash !== LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard
      )
        fail(
          "The operator guard deployment must match the exact reviewed source runtime.",
        );
      sessionGuard = pin(c, input.sessionGuard.address);
    }
  }
  const body = {
    id: `safe7579-f22a194-legacy-f24dddf-${input.chainId}${sessionGuard ? (guardVersion === "current-v2" ? "-guard-v2" : "-guard-v1") : "-owner"}`,
    // The complete base stack supports independently approved owner UserOperations.
    // Delegated sessions additionally require compilerStack and the verified guard.
    mode: "execution-candidate" as const,
    chainId: input.chainId,
    safeVersion: "1.4.1" as const,
    proxyRuntimeCodeHash: component("SafeProxy").runtimeCodeHash,
    singleton: pin(component("SafeL2")),
    factory: pin(component("SafeProxyFactory")),
    safe7579,
    launchpad: pin(component("Safe7579Launchpad")),
    entryPoint,
    smartSessions,
    policies: [
      sessionValidator,
      timeFrame,
      universalAction,
      valueLimit,
      ...(sessionGuard ? [sessionGuard] : []),
    ],
    moduleInspectorId: "safe7579-f22a194-trace-v1",
  };
  const manifest: SmartAccountManifest = {
    ...body,
    revision: fingerprint({
      ...body,
      manifestSha256: SMART_ACCOUNT_STACK_MANIFEST_SHA256,
      // Provider upgrades do not change owner bindings or their history namespaces.
      // A new installed guard gets a separate identity with its complete new provenance.
      ...(sessionGuard && guardVersion === "current-v2" ? {
        guardManifestSha256: CURRENT_PIMLICO_GUARD_MANIFEST_SHA256,
        paymasterManifestSha256: CURRENT_PIMLICO_PAYMASTER_MANIFEST_SHA256,
      } : {}),
    }),
  };
  const compilerStack: SessionCompilerStack | undefined = sessionGuard
    ? {
        smartSessions,
        sessionValidator,
        timeFrame,
        universalAction,
        valueLimit,
        sessionGuard,
      }
    : undefined;
  return {
    manifest,
    utility: pin(component("Safe7579DCUtil")),
    senderCreator: pin(component("SenderCreator")),
    entryPoint,
    compilerStack,
    sourceManifestSha256: SMART_ACCOUNT_STACK_MANIFEST_SHA256,
    paymaster: paymasterProfile === "pimlico-v7-current-flags" ? await currentPimlicoPaymaster(input.chainId) : {
      ...pin(component("PimlicoSingletonPaymasterV7")),
      profileId: "pimlico-singleton-v7-legacy-verifying" as const,
      paymasterAndDataBytes: 130 as const,
      paymasterDataBytes: 78 as const,
      modeOffset: 52 as const,
      modeValue: 0 as const,
    },
    createCompiler: () => {
      if (!compilerStack)
        throw new RestError(
          503,
          "SMART_SESSION_GUARD_DEPLOYMENT_REQUIRED",
          "Configure and verify a deployment of the exact reviewed CenterSessionGuard before compiling executable sessions.",
        );
      return createLegacySessionCompiler({ stack: compilerStack, guardVersion });
    },
  };
}
