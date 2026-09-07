# V6 target compiler and deployment evidence

This supplement supplies the missing compiler evidence for the published
`@bananapus/core-v6@1.0.2` `JBController` and `JBMultiTerminal` targets on all eight
catalog chains. It preserves the catalog's code identities and deployment
bindings. It does not authorize an address by itself: the target resolver must
also establish its project association at the request's canonical block.

The complete 82-file compiler input is bundled. Core source bytes come from
official Git commit `386a9dc71c73a1e614da9cf2a98e207788034a4b`; permission IDs come
from `e75d962ebcade48c0e19d849fe27a7e200b3ed74`. Every input, including third-party
dependencies, matches the Keccak-256 recorded in deployment metadata pinned to
`Bananapus/deploy-all-v6` commit `20883a7c7fcd58b6264f8375b6156a59ab9a2597`.
Dependency evidence proves exact bytes, without claiming an independently
verified npm release origin. `source-closure.json` records these distinctions.

Solidity 0.8.28 reproduces the full ABI, creation bytecode and runtime template.
The binary is checked against the official `ethereum/solc-bin` release digest.
Compiler settings, source metadata and compiler input identities match exactly.
Deployment artifacts contain Foundry's parsed metadata projection: empty
function outputs and top-level NatSpec sections were omitted. Reproduction
normalizes only this representation difference and checks the complete ABI
separately. No claim is made that omitted documentation fields were compared;
these deployments use `bytecodeHash: none`.

`JBController` has 54 compiler-declared immutable references. `JBMultiTerminal`
has 36, plus four compiler-declared link references to `JBHeldFees` and
`JBPayoutSplitGroupLib`. Linking substitutes only the exact published library
addresses at those declared offsets; link references remain in the manifest.
Both library creation bytecodes are executed in an isolated local Anvil using
`eth_call` state overrides at their published addresses. Their complete returned
runtimes include Solidity's self-address guard. Those runtime bytes are compared
exactly; no self-address pattern or guessed immutable mask is accepted.

The resolver must validate both library runtimes at the same canonical block
before comparing a linked terminal's runtime. Library addresses are never masked.
`observations.json` contains 32 public-RPC observations, covering all four
contracts on eight finalized blocks, with EIP-1898 canonical reads and subsequent
block-hash revalidation. These are dated evidence fixtures; request-time reads
must still verify current canonical state.

## Verify without a sibling workspace or public RPC

From the Center repository, with the pinned Foundry tools and Solidity 0.8.28
installed:

```sh
node --import tsx --test src/rest/smartAccounts/targets-evidence/verify.test.mjs
```

The test always recompiles the bundled input and starts/stops its own isolated
Anvil process. Set `CENTER_TARGET_SOLC` and `ANVIL_BINARY` when the executables are
outside their default SVM/Foundry locations. It verifies file integrity, compiler
outputs, the complete source closure, publication bindings, constructor-produced
library runtimes, all observed runtimes, and rejection of altered code and links.
No live-chain writes occur.

## Regenerate deliberately

Use the pinned official repositories and matching dependency bytes in an EVM
workspace. Start an isolated Anvil on port 47191, then run:

```sh
node src/rest/smartAccounts/targets-evidence/reproduce.mjs \
  --workspace /path/to/v6/evm \
  --solc /path/to/solc-0.8.28 \
  --evm-url http://127.0.0.1:47191
```

The script validates the complete source/deployment closure before writing its
compiler evidence. It records compiler output hashes and constructor traces.
It preserves any existing observation snapshot and records that file's hash.

To collect new read-only public-chain observations into a separate review file:

```sh
node src/rest/smartAccounts/targets-evidence/observe.mjs \
  --output /tmp/center-target-observations.json
```

An optional `--anchors` argument rereads the block hashes from an earlier
observation snapshot. Updating `observations.json` requires regenerating its
manifest hash and rerunning verification. Provider errors and fallback attempts
remain visible in the snapshot; missing observations never become successful
proofs.
