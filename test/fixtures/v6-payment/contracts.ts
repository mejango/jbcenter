// SPDX-License-Identifier: MIT
// Local fixture only. Executes the catalog-pinned V6 build; never fetches or broadcasts externally.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { encodeDeployData, encodeFunctionData, keccak256, toHex, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { getContractCatalog } from "../../../src/rest/contracts/catalog.js";

export type PaymentFixtureRpc = <T = unknown>(method: string, params?: readonly unknown[]) => Promise<T>;
type Build = { abi: Abi; bytecode: { object: Hex; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> };
  metadata: { compiler: { version: string }; sources: Record<string, { keccak256: Hex; license?: string }> } };
type Contract = Build & { address: Address };
const names = ["JBHeldFees", "JBPayoutSplitGroupLib", "JBPermissions", "JBProjects", "JBDirectory", "JBERC20", "JBTokens",
  "JBRulesets", "JBPrices", "JBSplits", "JBFundAccessLimits", "JBFeelessAddresses", "JBController", "JBTerminalStore", "JBMultiTerminal"];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** External MIT source artifacts are dependencies, not copied unreviewed build output.
 * Missing/changed artifacts fail this suite; they never silently skip its execution claim. */
export async function loadV6PaymentArtifacts() {
  const root = process.env.CENTER_V6_SOURCE_ROOT;
  assert(root, "Set CENTER_V6_SOURCE_ROOT to the catalog-pinned nana-core-v6 checkout with its reviewed out/ artifacts");
  const catalog = await getContractCatalog(), contracts = new Map<string, Contract>(), verifiedSources = new Map<string, Hex>();
  function load(path: string, expectedHash: string): Build {
    const bytes = readFileSync(resolve(root!, path));
    assert.equal(sha256(bytes), expectedHash, `Pinned artifact changed: ${path}`);
    const artifact = JSON.parse(bytes.toString("utf8")) as Build;
    assert.equal(artifact.metadata.compiler.version, "0.8.28+commit.7893614a");
    for (const [source, evidence] of Object.entries(artifact.metadata.sources)) {
      let hash = verifiedSources.get(source);
      if (!hash) { hash = keccak256(toHex(readFileSync(resolve(root!, source)))); verifiedSources.set(source, hash); }
      assert.equal(hash, evidence.keccak256, `Compiler input changed: ${source}`);
    }
    return artifact;
  }
  for (const name of names) {
    const entry = catalog.data.contracts.find(value => value.name === name && ["contract", "library"].includes(value.category))!;
    const source = entry.variants.flatMap(variant => variant.provenance).find(value => value.kind === "clean-source-build")!;
    assert.equal(source.commit, "feff600654aee6fb1747dded692f18068b2230a6");
    const deployment = entry.deployments.find(value => value.chainId === 8453)!.instances.find(value => value.alias === name)!;
    assert(deployment, `The pinned Base address is absent for ${name}`);
    contracts.set(name, { ...load(source.artifactPath.replace(/^nana-core-v6\//, ""), source.artifactSha256), address: deployment.address });
  }
  // This inherited OZ5 ERC20 has six decimals and suppresses Approval while spending allowance.
  // It is NOT Circle USDC: no proxy, blacklist, pausing, mint-role, or live Base token evidence.
  const token = load("out/MockERC20.sol/MockERC20.json", "17243795fc862e6583c649c0c92a206fb5322ee327d0d3ea776f1e3e0dd39130");
  return { contracts, token, verifiedSourceCount: verifiedSources.size };
}

/** Run actual constructors with canonical local dependency addresses, then transplant each
 * constructor's code and complete storage into those addresses. This is isolated test setup,
 * not a fork or evidence that these contracts were deployed or configured on Base. */
export async function deployV6PaymentContracts(
  artifacts: Awaited<ReturnType<typeof loadV6PaymentArtifacts>>, rpc: PaymentFixtureRpc, admin: Address,
  send: (data: Hex, to?: Address) => Promise<{ contractAddress: Address | null }>,
) {
  const get = (name: string) => { const contract = artifacts.contracts.get(name); assert(contract, name); return contract; };
  const at = (name: string) => get(name).address;
  const args: Record<string, readonly unknown[]> = {
    JBHeldFees: [], JBPayoutSplitGroupLib: [], JBPermissions: [zeroAddress], JBProjects: [admin, zeroAddress, zeroAddress],
    JBDirectory: [at("JBPermissions"), at("JBProjects"), admin], JBERC20: [at("JBPermissions"), at("JBProjects")],
    JBTokens: [at("JBDirectory"), at("JBERC20")], JBRulesets: [at("JBDirectory")],
    JBPrices: [at("JBDirectory"), at("JBPermissions"), at("JBProjects"), admin, zeroAddress],
    JBSplits: [at("JBDirectory")], JBFundAccessLimits: [at("JBDirectory")], JBFeelessAddresses: [admin],
    JBController: [at("JBDirectory"), at("JBFundAccessLimits"), at("JBPermissions"), at("JBPrices"), at("JBProjects"), at("JBRulesets"), at("JBSplits"), at("JBTokens"), zeroAddress, zeroAddress],
    JBTerminalStore: [at("JBDirectory"), at("JBPrices"), at("JBRulesets")],
    JBMultiTerminal: [at("JBFeelessAddresses"), at("JBPermissions"), at("JBProjects"), at("JBSplits"), at("JBTerminalStore"), at("JBTokens"), "0x000000000022D473030F116dDEE9F6B43aC78BA3", zeroAddress],
  };
  for (const name of names) {
    const artifact = get(name);
    let bytecode = artifact.bytecode.object;
    for (const libraries of Object.values(artifact.bytecode.linkReferences)) for (const [library, offsets] of Object.entries(libraries))
      for (const offset of offsets) {
        assert.equal(offset.length, 20);
        const start = 2 + offset.start * 2;
        bytecode = `${bytecode.slice(0, start)}${at(library).slice(2)}${bytecode.slice(start + 40)}` as Hex;
      }
    assert.match(bytecode, /^0x[0-9a-fA-F]+$/);
    const temporary = (await send(encodeDeployData({ abi: artifact.abi, bytecode, args: args[name] }))).contractAddress!;
    const raw = Buffer.from((await rpc<Hex>("anvil_dumpState")).slice(2), "hex");
    const state = JSON.parse((raw[0] === 0x1f ? gunzipSync(raw) : raw).toString("utf8")) as {
      accounts: Record<string, { code: Hex; storage: Record<Hex, Hex> }> };
    const account = state.accounts[temporary.toLowerCase()]!;
    assert(account?.code && account.code !== "0x", `Constructor did not produce code: ${name}`);
    await rpc("anvil_setCode", [artifact.address, account.code]);
    for (const [key, value] of Object.entries(account.storage)) await rpc("anvil_setStorageAt", [artifact.address, key, value]);
    assert.equal(await rpc("eth_getCode", [artifact.address, "latest"]), account.code);
  }
  await send(encodeFunctionData({ abi: get("JBDirectory").abi, functionName: "setIsAllowedToSetFirstController", args: [at("JBController"), true] }), at("JBDirectory"));
  const token = { ...artifacts.token, address: (await send(encodeDeployData({ abi: artifacts.token.abi, bytecode: artifacts.token.bytecode.object,
    args: ["Six-decimal V6 payment fixture", "FIXTURE"] }))).contractAddress! };
  return { get, at, token };
}
