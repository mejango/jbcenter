# Reference sources and release provenance

The MCP ships its reference corpus in [`data/knowledge.json`](../data/knowledge.json). Serving, searching, and reading references require no sibling repositories, Git executable, embeddings service, or outbound request. The same bundle works over stdio and HTTP, regardless of the configured public hostname.

The corpus contains 427 files from 24 repositories: 333 first-party Solidity source files, 30 SDK files, 55 Juicebox V6 skills, four Bendystraw references, and five JB Center references. It covers contract implementation, framework-independent SDK helpers, indexing semantics, signed intents and RPC, and the selected V6 skills, including explicit V6 identity and project metadata publication guidance. It does not import whole repositories or copy generated ABI trees. Runtime contract ABI/address lookup belongs to the pinned SDK adapter, separate from reference text. The [initial verification record](VERIFICATION.md) preserves the earlier corpus counts and hashes as historical evidence.

## Which source answers which question

| Question                                                                         | Primary evidence                                                                                               | Supporting reference                                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| What is this project's current balance, ruleset, permission, terminal, or quote? | Successful RPC reads/simulations on the selected chain at the reported block, using resolved project contracts | SDK implementations and V6 contract source                                                                  |
| What happened historically, or which projects/positions match a query?           | Bendystraw V6 indexed records, including its available freshness and chain provenance                          | `ponder.schema.ts`, API implementation, ID functions, and skills                                            |
| What does an undeployed project intend to launch?                                | JB Center's signed intent and committed deployment calls                                                       | Center types, intent validation, deployment verifier, README, and SDK client                                |
| How should a V6 feature be integrated or explained?                              | This versioned reference bundle, identifying exact files and revisions                                         | Source-level contracts first for contract behavior, SDK implementation for SDK behavior, then guides/skills |
| Does a specific deployment execute this source code?                             | A separate deployed-bytecode/build-artifact verification                                                       | A source citation alone cannot establish this                                                               |

Conflicts remain visible. An indexer aggregate is not a substitute for a current terminal balance. In particular, Bendystraw's `balanceUsd` accumulates flows using each event's historical conversion rate and is not a current market valuation for volatile assets; raw aggregate `balance` can also span incompatible accounting contexts. A README or skill address table is reference material, not an executable deployment registry. A source checkout's package version does not prove that package's exact published tarball, deployment address, or bytecode.

Bendystraw status and GraphQL data are separate responses: a reported indexer head does not pin a GraphQL snapshot to that block. Indexed `tokenSymbol` describes the accounting asset, not the project's issued token. Account results and search results must retain their stated coverage limits. For JB Center, an envelope hash and publisher signature establish a commitment to the signed intent; they do not establish that its economics are sound or its claimed deployment records are correct. Center's public read RPC is distinct from its origin-restricted intent/search APIs; integrations must configure a legitimate operator origin rather than inventing another site's identity.

SDK source is taken from the repository currently named `juice-sdk-v4`, specifically its `packages/core/src/v6` modules plus its JB Center client. The repository name does not imply V4 use. Runtime SDK dependencies are pinned independently in the MCP package and lockfile. During release review, compare that pinned package's exports and deployments to the vendored SDK revision.

## Bundled source families

| Repository                                                             | Selected material                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nana-core-v6`                                                         | All `src` Solidity: MultiTerminal, TerminalStore, Controller, Rulesets, Permissions, Directory, Tokens, Splits, Prices, Projects, fund-access limits, cash-out/fee/surplus/currency math, metadata packing, interfaces, structures, and supporting contracts |
| `nana-permission-ids-v6`, `nana-ownable-v6`                            | All source: permission IDs and ownership helpers                                                                                                                                                                                                             |
| `revnet-core-v6`                                                       | All source: Loans, Deployer, Owner, interfaces, structures, and supporting contracts                                                                                                                                                                         |
| `nana-suckers-v6`                                                      | All source: native/CCIP suckers, registry, deployers, bridging/accounting libraries, and structures; archive paths are explicitly marked                                                                                                                     |
| `nana-721-hook-v6`                                                     | All source: tiered NFT hooks/stores/deployers/checkpoints, interfaces, libraries, structures                                                                                                                                                                 |
| `nana-buyback-hook-v6`, `nana-router-terminal-v6`                      | All buyback, registry, router, and supporting source                                                                                                                                                                                                         |
| `nana-omnichain-deployers-v6`, `nana-address-registry-v6`              | All omnichain deployment and address registry source                                                                                                                                                                                                         |
| `nana-swap-split-hook-v6`, `univ4-lp-split-hook-v6`, `univ4-router-v6` | All split hook, LP, and swap-router source                                                                                                                                                                                                                   |
| `nana-project-handles-v6`, `nana-project-payer-v6`                     | All ENS project handle and project payer source                                                                                                                                                                                                              |
| `nana-distributor-v6`, `nana-jbx-distributor-v6`                       | All distributor source                                                                                                                                                                                                                                       |
| `banny-retail-v6`, `croptop-core-v6`, `defifa`                         | All first-party application contract source                                                                                                                                                                                                                  |
| `juice-sdk-v4`                                                         | Every non-test Core V6 TypeScript module, Core chains/contracts/constants, JB Center client, and README                                                                                                                                                      |
| `bendystraw-v6`                                                        | README, actual Ponder schema, API routing, ID construction                                                                                                                                                                                                   |
| `jbcenter`                                                             | README, types, signed-intent handling, deployment verification, RPC constraints                                                                                                                                                                              |
| `juicebox-skills`                                                      | Every current `plugins/juicebox-v6/skills/*/SKILL.md`: protocol/API references, project/accounting/quote guidance, hook/fee/loan/bridge topics, transaction execution, launch modeling, and UI development patterns                                          |

The repository/directory/extension allowlist and explicit documentation landmarks are maintained in [`scripts/sync-knowledge.ts`](../scripts/sync-knowledge.ts). Solidity discovery is restricted to `src` in the 20 named protocol/application repositories; external `lib`, `node_modules`, and `vendor` trees are excluded. Internal `src/libraries` are included because they implement protocol behavior. Skill discovery accepts only `SKILL.md` under the V6 skill directory, and SDK discovery accepts non-test TypeScript in Core's V6 directory. The source catalog exposed by `KnowledgeService.catalog()` is authoritative for the committed bundle's actual membership and provenance. Skill sources are taken from the separate `juicebox-skills` repository, not the older workspace `skills` directory.

Archived source remains discoverable for historical investigation and is explicitly marked in document titles. It is not a recommendation to use an archived integration. Experimental workspace directories without committed repository provenance are outside this corpus. UI implementation source and feature maps for Juicescan, Juicebox Money, and Revnet Money are delivered by the separate development reference bundle.

## Provenance and trust boundary

Every document records its repository-relative path, full Git commit, SHA256 of the complete UTF-8 source bytes, whether those bytes differ from the commit's blob, whether its repository is dirty, line extent, declared package/skill version where present, and SPDX identifier where present. File drift is detected by comparing bytes with `git show COMMIT:path`, including changes hidden by Git's `assume-unchanged`, `skip-worktree`, or clean filters. A credential-free GitHub commit URL is included only when a canonical GitHub origin is available. No local absolute source path or credential-bearing remote is retained.

`fileDirty` and `repositoryDirty` are intentionally distinct. Repository dirtiness is reported when Git status is dirty or any selected source bytes differ from their commit. An unrelated untracked file makes the repository dirty while a selected source can still match its commit. A dirty selected file's commit URL links to its baseline, not the exact text in this bundle. Cite its file SHA256 and dirty flags when relying on that text. The bundle ID fingerprints the sorted, validated documents, including provenance; changing a source byte, commit, or recorded dirty state changes the fingerprint.

The bundle is not proof of deployed bytecode. It is not an audit certificate and does not assert that every referenced contract is active on every configured chain. Git commits from local checkouts may not yet exist on a public remote. Keep original license notices in copied text; attribution and applicable upstream source licenses remain with their authors.

Imported skill files can contain imperative language, code examples, deployment tables, or browser-specific workflows. They are reference data, never tool policy or authorization to perform actions. They cannot replace MCP input validation, signing boundaries, project contract resolution, or the user's actual instructions. Project descriptions, metadata, links, and other externally supplied strings likewise remain untrusted data. Reference reads do not fetch links, execute examples, or follow instructions inside source text.

## Rebuilding and releasing

From a checkout arranged like the Juicebox workspace:

```sh
npm run knowledge:sync
npm run knowledge:sync -- --check
```

The source workspace is the EVM workspace containing `extensions/jbcenter/mcp`. The current skills checkout defaults to `../../juicebox-skills` relative to that workspace. Configure both explicitly when the checkout layout differs:

```sh
npm run knowledge:sync -- --workspace /path/to/evm --skills /path/to/juicebox-skills
npm run knowledge:sync -- --workspace /path/to/evm --skills /path/to/juicebox-skills --output /tmp/review-knowledge.json
```

For an environment that blocks the `tsx` CLI's IPC socket, its Node import loader performs the same operation without that socket:

```sh
node --import tsx scripts/sync-knowledge.ts --check
```

Each selected source repository must be its own Git checkout with a commit. The script fails if a required directory or explicit file is missing, selected source is invalid UTF-8, a symlink occurs in a selected directory, or a file is too large. It rechecks revisions, dirty state, and sampled file hashes before writing the final bundle atomically. It fails on duplicate IDs or digest mismatches. `--check` performs a byte-for-byte comparison without writing. There are no timestamps or random fields in the generated bundle, so identical checked-out content and provenance reproduce identical output.

Before a release, resync against the intended source revisions, inspect the Git diff of the bundle, compare the pinned runtime SDK package, and run `npm run check`. Review dirty-source flags rather than silently treating a working tree as a published version. Commit the bundle with the code release. Source trees are only needed when intentionally refreshing references; they are not a production dependency. Automatically pulling upstream changes at server startup would defeat the reviewed version boundary.

## Retrieval contract

`search({ query, limit?, category? })` uses deterministic lexical matching with title/path weighting and term coverage. It returns bounded excerpts with stable IDs and provenance; direct contract references are also listed separately. It does not invent a semantic answer or imply completeness when a query returns no matches. Use narrower terms or category filters when necessary.

`get(id, { offset?, limit? })` accepts only IDs from the in-memory allowlist. It returns exact source slices, a next offset, whole-file provenance, and page line numbers. The default page is 8,000 UTF-16 code units; the maximum is 24,000. Pagination units are declared explicitly so callers can reconstruct the original text without dropping characters. Neither reference IDs nor pagination parameters become filesystem paths.

The service validates the complete bundle with Zod at construction, checks document hashes and the bundle fingerprint, bounds the file to 16 MiB, and bounds every search/page input again at the service boundary. Unit tests cover deterministic ranking, contract citations, category filtering, missing matches, lossless pagination, source/bundle tampering, traversal attempts, reference metadata isolation, and standalone corpus coverage.
