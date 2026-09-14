# Local V6 payment execution fixture

`npm run check` prepares the committed fixture in a fresh temporary directory,
verifies it against the catalog and compiler metadata, and removes the temporary
directory afterward. CI performs the same preparation explicitly. Neither path
needs another repository checkout or downloads contracts.

To run only the EVM test with Node 22 and Anvil installed, choose a new absolute
directory whose parent exists and contains no symlinks:

```sh
node scripts/rest/prepare-v6-payment-fixture.mjs --output /absolute/new-fixture
CENTER_V6_SOURCE_ROOT=/absolute/new-fixture npm test -- test/rest-wallet-v6-payment-evm.test.ts
```

An explicit `CENTER_V6_SOURCE_ROOT` also permits a reviewed source checkout with
matching `out/` artifacts. It receives the same verification; it never bypasses
the pins. Preparation refuses an existing output directory and validates bounded
compressed data, every file hash, and the complete safe path inventory before
writing. Files are created exclusively without following symlinks.

## Portable evidence

`pinned.json.gz` preserves the exact original UTF-8 bytes of 16 artifact JSON
files, all 135 Solidity compiler inputs, and five MIT license notices.
`pinned-manifest.json` records the compressed and uncompressed SHA256 values,
sizes, ordered file inventory, original artifact hashes and source keccak hashes.
No artifact projection or catalog pin was substituted. The normal verifier in
`contracts.ts` independently checks the extracted files against Center's catalog
and every compiler input named by the original artifact metadata.

The source commit is `feff600654aee6fb1747dded692f18068b2230a6`; the compiler is
Solidity `0.8.28+commit.7893614a`. All selected sources are MIT-licensed. Notices
cover the core project, permission IDs, OpenZeppelin, PRB Math and Permit2.
The installed OpenZeppelin package omits its full license text, so its notice is
preserved separately under `licenses/`, with the official v5.6.1 tag's immutable
commit, URL and SHA256 recorded beside it.

The unchanged upstream `test/mock/MockERC20.sol` artifact is pinned to SHA256
`17243795fc862e6583c649c0c92a206fb5322ee327d0d3ea776f1e3e0dd39130`.
It has six decimals and inherits OpenZeppelin's allowance-spend behavior without
an extra `Approval` event.

Explicit offline regeneration from the reviewed original checkout is:

```sh
CENTER_V6_SOURCE_ROOT=/absolute/reviewed-checkout node --import tsx scripts/rest/generate-v6-payment-fixture.ts
```

The generator runs the unchanged verifier first, rechecks the captured bytes,
preserves notices, and writes deterministic gzip and manifest outputs. Two
generation runs produced identical bytes. Regeneration does not authorize new
sources, altered pins, or production deployment.

## Compiler reproduction and its limit

An isolated clean compiler run reproduced all 16 full artifact JSON hashes
exactly: Forge v1.7.0 (`f83bad912a9dba7bf0371def1e70bb1896048356`), Solidity
0.8.28, the original 410 source units, 276 explicit repository entrypoints, the
pinned forge-std commit, fixed original remappings and the original 110 external
Solidity dependency files. Its output passed the unchanged catalog verifier.

This was not a clean installation from the upstream npm lockfile. At the pinned
source commit, package.json requests permission IDs ^1.0.0 while its lockfile
contains ^0.0.32; the reviewed compiler inputs used 0.0.28. PRB Math was installed
at 4.1.1 while the lock specifies 4.1.2. A default build also includes 45 extra
source files that change global source IDs and full artifact JSON. CI therefore
uses the verified fixture, without claiming that an untouched upstream clone
and `npm ci` reproduce it.

## Execution claims

The fixture runs real constructors, then transplants their code and complete
constructor storage into the local addresses required by the production SDK.
Project launch, RPC snapshots, `PaymentService.preparePay`, passkey/FCL approval,
Safe execution, EntryPoint, V6 accounting, and the production canonical receipt
observer execute normally. Only setup can use Anvil mutation methods.

This proves local V6 execution with a six-decimal ERC20 fixture. It does not prove
Circle USDC proxy/admin/blacklist behavior, a Base deployment, physical-device
behavior, live fees, paymaster/bundler acceptance, or full wallet authority
admission. The account callback checks only the canonical runtime, owner,
threshold, module, singleton, fallback and guard properties named in the test;
full authority and history checks have separate suites. The compressed fixture
is a test dependency and is not copied into the runtime image's assets.
