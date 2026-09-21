# Initial implementation verification

Recorded on 2026-09-06. These checks establish the behavior described below; they do not establish deployment availability, audit every upstream contract, or exercise every transaction against a live chain.

## Repository checks

`npm run check` passed using Node 22.23.1: formatting, strict TypeScript checking, 293 tests across 19 files, production compilation, and a byte-for-byte generated catalog check using the official MCP client. The catalog contains 54 tools across nine capability families, three static resources, two resource templates, and four prompts.

The tests cover exact SDK calldata and decoding, integer/schema boundaries, canonical RPC snapshots and reorganization detection, the actual Bendystraw V6 GraphQL schema, Center commitments/signatures, protocol economics and permissions, hook compositions, plan authentication and prerequisites, semantic receipt verification, source integrity, and both MCP transports. Financial regression fixtures check concrete contract behavior, including per-asset loan liquidity, fee exemptions, NFT pricing feeds, routed NFT credits, locked splits, and clearing registry overrides.

The contract/SDK/skill bundle reproduces byte for byte from the selected source workspace: 425 references from 24 repositories, fingerprint `d3595cf5fa0573400fdb8c0253de59c4229ee5525b57f6a62a5c0cb837304ce5`. Webclient development also reproduces byte for byte: 100 references and 15 feature maps, fingerprint `0a4085bcaa098e70f653ca363e6fce858a2c29842aa82219082c8634a78ea507`. Each bundle records exact source hashes and provenance; dirty-source flags need deliberate release review. Generator tests detect selected-file changes hidden by Git flags and prevent mixed-source snapshots or unsafe output replacement.

## Packaged runtime

The Docker build passed with zero reported dependency vulnerabilities in its build and production install stages. The locally verified image is `juicebox-mcp:local-verify`, image SHA256 `a612997cd5bc050a34a05dec2b04eb7c8b94395360bb326d6dc33fe478ea8e54`.

The container ran as UID 1000 with a read-only filesystem, external networking disabled, all Linux capabilities dropped, and `no-new-privileges`. Official MCP clients initialized both the actual compiled HTTP server and compiled stdio entry point. Both returned the complete catalog, read every static resource, retrieved the webclient prompt, and executed the capabilities tool. HTTP was stateless, readiness reported local readiness with upstream health unchecked, stdout stayed empty, and SIGTERM exited cleanly. Stdio diagnostics stayed on stderr and the child process closed successfully.

## Live read check

The opt-in `npm run smoke:live -- 8453 1` read Base V6 project 1 through the public JB Center RPC gateway at block `50966654`, hash `0x5eb44f561fc1b9a5fce3b62af078837f917b5d87ab17e31a005835d0be937ac4`. Its owner and canonical controller resolved successfully. The adapter used EIP-1898 block-hash state reads. A noncanonical terminal's accounting store was explicitly unknown with `UNSUPPORTED_TERMINAL_ACCOUNTING`; no guessed balance was substituted. This is a time-specific observation, not a fixture that assumes the project will retain that configuration.

A separate live routing read of the same project at Base block `50966741`, hash `0x1235abe2274ca90492758fb50b70588263d4597650e4859df772a31c2af20640`, resolved the revnet owner hook, its 721 and buyback hooks, both pay/cash-out hook ordering, router registry and cohort default, native-token primary terminal, and configured Uniswap V4 buyback pool. It correctly reported zero active liquidity and an unseeded oracle. The terminal with no accounting store was the router registry, whose context list was empty; that observation was not treated as evidence that routed payments are unavailable. No executable price was inferred from the initialized pool's spot state.

The NFT storefront and revnet readers also passed on that project at Base block `50966783`, hash `0xb0c5d06781d14400fb8c05cb19ef4e56b5ef4005381ac1f0ea97a15d38d8f170`. The storefront verified the canonical hook clone and returned its actual empty tier list. The revnet reader returned its deployment commitment, current and original stage, owner, loans contract, hook, and cash-out delay. It kept the current operator unknown because the owner exposes a candidate predicate rather than an enumerable getter.

## Remaining release checks

- Production Bendystraw access needs actual configured endpoints. Its API was verified with source-derived schemas and fixtures, without production credentials.
- Center search and intent reads need an operator-approved integration Origin. Signed-intent preparation is local; fixtures verify commitments and publisher signatures. No origin was impersonated for testing.
- Financial transactions were encoded, simulated against controlled fixtures, and verified against receipt fixtures; no transaction was signed or broadcast. Before using a prepared transaction, the client must review its exact payload and perform fresh simulation through its configured chain provider.
- Unsupported custom hook/terminal compositions, partial buyback execution, and positive NFT-tier split forwarding remain explicit capability limits. Source/ABI availability does not imply a dedicated transaction adapter for every contract method.
- Hosting, TLS, production secrets, ingress quotas, configured upstream monitoring, and live client access at the chosen domain remain deployment work. No remote repository or hosted service was published.
