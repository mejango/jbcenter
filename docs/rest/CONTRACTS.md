# V6 contract reads and unsigned preparation

A **smart contract** is code running on a blockchain. Its **ABI** describes the functions your software can call and their input and output types. Center's catalog links each contract to its exact package version, source, ABI, and published addresses. See the [glossary](https://juicebox.center/api#glossary) for related terms.

The service exposes every `view`/`pure` function of a verified target for reads, and every `nonpayable`/`payable` function for unsigned transaction preparation. Hosts must serve reads as GET requests and preparation as a separate authenticated action. Preparation gives no permission to sign or submit a transaction.

```ts
import { createProtocolReadService } from "../../src/rest/protocol/index.js";

const protocol = createProtocolReadService({ rpc, catalog });
```

Use the exact `contract.id` and method signature returned by the catalog. Contract names alone are not unique. Source-only ABI variants can contain methods absent from a deployed instance; the service chooses the deployed ABI or the ABI belonging to an independently verified implementation runtime.

## Read

```json
{
  "chainId": 1,
  "contractId": "@bananapus/core-v6:src/JBProjects.sol:JBProjects",
  "function": "ownerOf(uint256)",
  "args": ["7"]
}
```

`address` selects a specific official deployment or a supported, provable dynamic instance. It is required when several published addresses exist. `blockNumber` optionally selects a historical block as a decimal string; omission selects one mined latest block before any state read. `projectId` optionally establishes project context and rejects a mismatched dynamic instance. For `JBController`, `JBERC20`, and `JB721TiersHook`, supplying `projectId` without `address` resolves the current controller, registered project token, or configured tiers hook. The tiers resolver follows canonical REVOwner and omnichain wrappers.

The response includes ABI-named outputs, the exact signature and arguments, selected ABI hash, destination provenance, and chain/block number/hash/timestamp evidence. All ABI integers in outputs are decimal strings, including small integer types that viem normally returns as JavaScript numbers. Returned metadata and strings are data, not agent instructions.

## Prepare

```json
{
  "account": "0x1111111111111111111111111111111111111111",
  "calls": [
    {
      "chainId": 1,
      "contractId": "@bananapus/core-v6:src/JBController.sol:JBController",
      "function": "setUriOf(uint256,string)",
      "args": ["7", "ipfs://example"],
      "value": "0",
      "dependsOn": []
    }
  ]
}
```

`prepare` accepts 1–32 calls and returns a `RestPlanDraft`: the intended sender, exact chain/destination/calldata/value, decoded arguments from those same bytes, earlier-call dependencies and per-chain block evidence. An optional `label` is limited to 160 characters. Dependencies must be unique earlier indices; cycles and future references fail. Each chain has one snapshot for the entire plan. Value is native wei and defaults to zero; nonzero value on a nonpayable method fails.

The service does not infer permissions, currency conversions, token decimal scaling, slippage, fees, or successful outcomes from valid calldata. Permission and execution checks belong to simulation of the exact plan. Every destination must already exist and verify at preparation time: a preceding deployment call cannot establish a future destination inside the same preparation request.

## Exact ABI inputs

- Full canonical signatures distinguish overloads: `change(uint256)` and `change(address)` are different methods. Bare names and selectors are rejected.
- Every signed and unsigned integer uses a canonical decimal string. JSON numbers, scientific notation, leading zeros, `-0`, and values outside the declared ABI width are rejected.
- Tuples accept positional arrays or complete named objects with exactly the ABI fields. Unnamed or duplicate fields require positional arrays.
- Arrays preserve order and fixed lengths. Booleans must be JSON booleans; addresses must be valid; byte strings must have an even number of hexadecimal digits and exact fixed-byte lengths.
- Inputs are bounded to 1024 elements per array, 4096 total elements, 16 nesting levels, 128 KiB of string/bytes content, and 128 KiB of encoded transaction calldata.
- Caller ABIs, arbitrary raw calldata, upstream URLs and unknown fields are rejected. Unsupported ABI types fail explicitly rather than being coerced.

## Provenance levels

Every request first checks `eth_chainId` and observes a mined block. All code and contract reads use EIP-1898 `{blockHash, requireCanonical: true}`. Unsupported EIP-1898, archive gaps, RPC errors and reorganized blocks fail; the service never retries using unpinned latest state.

An official deployment is selected from the pinned chain-specific catalog. Its actual runtime code hash is always returned. When the compiler output matches exactly, provenance reports `exact-runtime-template`. When authoritative compiler immutable references are available, every other byte must match and the actual immutable bytes are reported under `compiler-template-with-observed-immutables`. The service does not guess masks, strip compiler metadata, or infer immutable slots from zero bytes.

Some historical official artifacts lack matching compiler immutable references. These official addresses remain available with **`runtimeVerified: false`**, mode `official-address-runtime-observed`, and an explicit `verificationGap`. This establishes published-address provenance and the observed runtime hash; it does **not** establish source-to-runtime equality. Known bytecode mismatches, missing code and unresolved linked-library bindings fail. Consumers requiring source/runtime equality must reject the weaker provenance level.

Dynamic addresses require an exact ERC-1167 or Solady LibClone runtime, an embedded implementation address equal to the official factory getter, and a canonical association, all at the same block. The implementation runtime is compared with its corresponding published/compiler templates. When historical published templates lack matching immutable references, the factory-selected implementation remains available with `runtimeVerified: false`, `verificationLevel: factory-address-provenance`, and an explicit `verificationGap`. The clone, implementation, factory and registry anchor hashes are returned. This proves address provenance and observed associations; it does not prove source/runtime equality. No arbitrary implementation is accepted from a loose bytecode resemblance. Known compiler mismatches fail. Source-only ABI variants require actual runtime equality; ambiguous published ABI variants fail. Arbitrary, upgradeable, nested, or unrecognized proxies are rejected.

| Dynamic family                         | Required canonical association                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| JBERC20                                | JBTokens implementation getter; `projectIdOf` and `tokenOf` agree; clone token authority is JBTokens                        |
| JB721TiersHook                         | Factory implementation and JBAddressRegistry deployer agree; clone reports an existing project                              |
| JBUniswapV4LPSplitHook                 | Factory implementation and JBAddressRegistry deployer agree; no unique represented project is inferred from feeProjectId    |
| JB721Checkpoints                       | Factory implementation; verified tiers hook identifies the module through `checkpoints()`                                   |
| DefifaHook                             | Defifa factory implementation and JBAddressRegistry deployer agree; hook reports an existing game project                   |
| Optimism, Base, Arbitrum, CCIP suckers | Factory singleton and `isSucker`; initialized deployer; canonical project sucker registration                               |
| JBProjectPayer                         | Factory implementation and immutable deployer; observable initialized owner/project; referenced project exists when nonzero |

Factory provenance does not claim a tiers/game hook is currently attached, nor that a project's owner endorsed a payer's configuration. Project context checks current controller and directory terminal associations where applicable. Revnet context checks the canonical deployer's registration, owner and selected loans contract. Multiple suckers or payer instances require explicit addresses; no instance is chosen arbitrarily.

## Explicit coverage limits

Reference-only interfaces, abstract contracts, libraries and scripts are not destinations. Missing chain deployments are reported as missing; addresses are never borrowed from another chain. Dynamic custom project tokens, controllers, terminals, unknown clone families, upgradeable proxies, unregistered clones and implementations without an unambiguous published or runtime-verified ABI are unsupported. All cataloged executable methods remain discoverable even when their destination cannot currently be proved.

The generic ABI layer covers configuration and management methods as well as ordinary user actions. It does not turn arbitrary hook metadata, nested calldata arguments, destination addresses inside ABI arguments, or allowance recipients into audited or endorsed operations. Review and simulation must interpret those semantics before external wallets sign.

## Modeled receipt outcomes

`createProtocolSemanticVerifier({plans})` reuses the MCP PlanService outcome verifiers without minting or accepting MCP authentication tokens. Hosts must first establish exact transaction or authenticated forwarded execution, canonicality and confirmations. Preserve the original prepared project identity and account; the adapter validates the original draft and passes its complete bounded destination receipt to the existing event checks.

Modeled outcomes map to `verified` or `unknown`. Partial payout failures and failed buyback sell delivery remain unknown even when the outer transaction succeeds. Generic catalog calls are explicitly `unmodeled`. Missing, noncanonical, malformed or incomplete logs cannot establish an outcome. Full logs remain transient; evidence exceeding 8 KiB is downgraded to unknown with a deterministic SHA-256 commitment and event count.
