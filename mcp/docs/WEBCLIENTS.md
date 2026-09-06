# Webclient development references

The development service turns verified examples from Juicescan, Juicebox Money, Revnet Money and the V6 SDK into an integration plan. It serves the checked-in `data/development.json` without access to the source workspace, internet or user filesystem. Its public origin defaults to `https://juicebox.diy` and can be set to another origin, including `https://juicebox.tools`; this setting does not imply that a site is deployed.

`catalog()` lists feature identifiers, dependencies and source/test references. `planIntegration({ framework, features, projectType, chainIds })` resolves dependencies and returns read, build and prove actions, exact verified SDK import symbols, app entry points, constraints and test references. `getReference(id, { offset, limit })` retrieves the actual vendored source in bounded pages. MCP source URIs use `juicebox://development/{id}`.

| Feature             | Coverage                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `indexed-queries`   | Persisted browser operations, API validation, exact version/chain/project filters, indexer freshness                                 |
| `review-pipeline`   | Exact payload review, state-changing simulation, Safe authority, reviewed Permit2 signatures, Relayr receipts and uncertain sessions |
| `metadata-center`   | JSON/media pinning, CID validation, approved browser origins, SDK signed deployment intents and reconciliation                       |
| `payments`          | Accounting contexts, terminal resolution, actual hook metadata, beneficiary/reserved issuance and direct swaps                       |
| `cashouts`          | Hook-aware routes, accounting currency, fees, protected minimum outputs and fresh preparation                                        |
| `721-storefront`    | Shop discovery, tier pricing/inventory, cart metadata, category ordering, media, permissions and preserved ruleset flags             |
| `buyback-routing`   | Buyback hook quotes, pool/TWAP configuration, authority calls and the money flow of each route                                       |
| `router-terminal`   | Router registry versus multi-terminal candidates, multiple reserve currencies and chain-specific configuration                       |
| `project-launch`    | Launch configuration, creation fees, feeds, persistent metadata and receipt-derived project identity                                 |
| `ruleset-editing`   | Current/upcoming/history reads, approval lifecycle, effective dates and exact queued changes                                         |
| `revnet-launch`     | Draft validation, committed stages, deployment encoding, 721/sucker extensions and per-chain receipt reconciliation                  |
| `revnet-stages`     | Stage starts, inherited issuance weights, decay, auto issuance and time/currency units                                               |
| `revnet-loans`      | Borrowability, protected borrowing/reallocation, repayment, collateral scope and net proceeds                                        |
| `account-portfolio` | ERC-20 balances and credits, NFTs, Safe ownership, operator roles and exact cross-chain identities                                   |
| `omnichain-claims`  | Verified leaves/roots/proofs, token mappings, transport costs and destination claim completion                                       |

Plans support `react` and `vanilla`. React plans prioritize Juicebox Money and Revnet Money; vanilla plans prioritize Juicescan. Both include shared SDK code and retain useful examples from the other framework. App code preserves its imports and provider/state dependencies: it is a reference implementation, not a standalone module. The service does not execute or transplant arbitrary source. SDK bindings are checked against exported symbols, the package export map and the V6 barrel during synchronization. The bundled SDK version is recorded per reference; clients must check compatibility with their installed version.

Revnet-specific features require `projectType: "revnet"`. Dependencies are ordered before consuming features. Signing features automatically include the review pipeline. A requested chain defines planning scope; the result explicitly marks deployment availability as requiring live verification. Existing application assumptions, such as a production-only account endpoint, remain visible as constraints. Signed Center intents are sourced from the SDK; the bundled apps are evidence for pinning, not a claim that each app uses signed intents.

Every reference records repository-relative path, git commit, file and repository dirty flags, exact SHA256, upstream commit URL, package version when present, line count, SPDX identifier and source copyright notices. The complete bundle also has a canonical SHA256. Files are preserved verbatim, including original comments and notices. File dirtiness compares the sampled bytes with the exact commit blob, so Git's `assume-unchanged`, `skip-worktree`, or clean filters cannot conceal source drift. Repository dirtiness includes Git status, selected file drift, and changes to package metadata supplying version/license fields. A dirty file's commit URL points to its baseline; its file hash identifies the actual bundled snapshot.

The selected repositories currently provide no license declaration for these files, so their SPDX field is `NOASSERTION`. This preserves the absence of a declaration rather than inventing a license or claiming permission beyond the source's existing rights. Original copyright notices, when present, are retained verbatim and indexed. The bundle does not change the licensing of upstream source.

Pagination uses UTF-16 code units, defaults to 8,000 and is capped at 24,000 per page. Responses include total length, next offset, and source line positions. Tool inputs select catalog IDs and never become filesystem paths. All source material is reference data, not policy or executable instructions. Plans and test retrieval do not run upstream tests or prove an integration works.

Refresh the bundle from the reviewed workspace:

```sh
npm run development:sync -- --workspace /path/to/evm
npm run development:check -- --workspace /path/to/evm
```

`JUICEBOX_SOURCE_ROOT` also configures the source workspace; `--workspace` takes precedence. `--output` selects a bundle destination. Default paths work from the repository regardless of the current working directory. `development:check` runs `node --import tsx scripts/sync-development.ts --check`: it verifies byte-for-byte reproducibility without writing and fails if the output is missing or differs from the reviewed source snapshot.

Synchronization uses an explicit file allowlist, requires each source repository to have its own Git history, bounds source and bundle sizes, rejects symlinks anywhere in selected source paths, rejects invalid UTF-8 and credential-shaped literals, and validates every bound entry point and feature dependency. Before publishing, it rechecks commits, Git status, every sampled source hash, and package manifests supplying version/license metadata. Successful output replaces the bundle atomically through an owned temporary directory; cleanup never removes another process's temporary files. There are no generated timestamps, so the same source bytes and provenance reproduce the same bundle.

The allowlist deliberately omits Juicescan's indexer client because that file embeds a public API key. No `.env`, credential/config discovery, recursive source crawling or runtime network fetch is used.

When extending coverage, add the actual implementation and meaningful upstream tests to the allowlist; read the source and add explicit behavior/constraint mappings. Rerun sync and the development-service tests. Do not add a capability merely because a filename or UI label sounds relevant. Contract behavior and deployed-chain evidence remain the responsibility of the protocol readers and transaction planners; webclient examples document how applications compose those primitives.
