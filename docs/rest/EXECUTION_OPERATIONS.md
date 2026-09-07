# Operating hosted smart-account execution

The repository contains the session compiler, installed-policy verifier, owner activation/revocation preparation, durable execution tracking, and the hosted ERC4337 transport. Production recurring execution requires a deployed and verified `CenterSessionGuard`, an operator's funded sponsorship policy, working archive traces, and an owner-approved session. The checked guard artifact has **no deployed address**. Local tests create disposable contracts and use test signers; they do not provision a provider account or install modules on a user's wallet.

All commands below run from the `jbcenter` repository root. The deployment command is provided for an operator to review and execute; it has not been broadcast as part of implementation.

## Required release checks

Use Node.js 22 and Foundry **v1.7.0**, release commit `f83bad912a9dba7bf0371def1e70bb1896048356`. The official binaries may print `1.6.0-v1.7.0`; the check verifies their exact commit. CI pins both the [official installation action](https://github.com/foundry-rs/foundry-toolchain/tree/908c540300062bd5a7e473851cdb4282204cee09) and the [Foundry release](https://github.com/foundry-rs/foundry/releases/tag/v1.7.0). With Foundry's installer already installed, select that release with `foundryup --install v1.7.0`.

```sh
npm ci --ignore-scripts
npm --prefix mcp ci --ignore-scripts
npm run check:execution
# Supply TEST_DATABASE_URL for the disposable integration-test database.
npm run check
```

`check:execution` requires both Forge and Anvil, verifies all 17 checked artifacts and the aggregate manifest, forces a fresh guard compilation, compares its ABI/creation/runtime bytecode and compiler settings, and runs the complete Foundry suite. The minimum required suites contain 12 guard tests and six actual EntryPoint/Safe/SmartSession/Pimlico tests, including direct submissions, expiry, revocation, sponsorship, budget consumption and failed execution. Skipped tests and fewer than 256 runs of an included fuzz test fail the command. Solidity is pinned in `src/rest/smartAccounts/stack/foundry.toml` to **0.8.28**, Cancun, optimizer 200 runs, and metadata bytecode hash `none`.

The same required check recompiles the bundled V6 controller/terminal source closure, verifies compiler-declared masks and catalog identities, executes library constructors on an isolated Anvil instance, and checks all 32 recorded deployment observations plus negative runtime mutations. It reuses the compiler installed by Forge, verifies its official Linux/macOS binary hash, and needs no sibling workspace or live RPC credentials. An explicitly selected compiler path may be supplied through `CENTER_TARGET_SOLC`; it must pass the same binary hash check. Once the pinned tools/compiler are installed, these verification steps use local files and a disposable local EVM only.

The guard's gas-estimation storage proof is also compared with the complete fresh compiler storage layout, bound to the same source, runtime and compiler version. An invented or stale field offset cannot pass the release check.

`npm run check` starts with that execution check and then runs the application/MCP checks, including the Anvil suites. CI installs Forge and Anvil before running it and supplies a disposable PostgreSQL service. Missing binaries fail before Vitest can conditionally skip an Anvil suite. `npm test` alone is not the release gate. Configure the repository's branch protection to require the `CI / test` job; the workflow cannot configure branch protection itself.

`npm run verify:execution-artifacts` is the smaller read-only provenance check. Neither verification command regenerates reviewed artifacts or updates a manifest. A deliberate guard source change requires a new reviewed build, source/runtime pins, tests and deployment; do not use `--write-manifest` to make a verification failure disappear.

## Operator configuration

The normal application environment still requires `DATABASE_URL`, `METRICS_TOKEN`, `DWELLIR_API_KEY` and the intended `REST_PUBLIC_ORIGIN`; see the repository's deployment instructions. Startup applies the database migrations. `npm run migrate` applies them explicitly when the deployment process runs migrations separately.

`REST_ERC4337_CONFIG` is optional, server-only JSON with this exact shape. The values below illustrate the format and gas units; replace the endpoint/policy placeholders and review every ceiling for the selected chain. These numbers are not recommended spending budgets.

```json
{
  "chains": [
    {
      "chainId": 11155111,
      "bundlerUrl": "https://YOUR-BUNDLER-ENDPOINT.invalid/?apikey=YOUR-SERVER-SECRET",
      "paymasterUrl": "https://YOUR-PAYMASTER-ENDPOINT.invalid/?apikey=YOUR-SERVER-SECRET",
      "paymasterPolicyId": "YOUR_SPONSORSHIP_POLICY_ID",
      "confirmations": 2,
      "gas": {
        "maximumCallGas": "1000000",
        "maximumVerificationGas": "1500000",
        "maximumPreVerificationGas": "200000",
        "maximumPaymasterVerificationGas": "200000",
        "maximumPaymasterPostOpGas": "100000",
        "maximumFeePerGas": "30000000000",
        "maximumPriorityFeePerGas": "2000000000",
        "maximumCost": "90000000000000000"
      }
    }
  ]
}
```

After deployment verification, add `"sessionGuardAddress": "<the verified address>"` to that chain object. The loader selects the reviewed runtime hash itself; there is no client-supplied hash override. Omitting the guard still permits configured, verified owner execution, but session compilation requires the guard.

| Field | Contract |
| --- | --- |
| `chains` | Required array when JSON is supplied; at most eight entries, each chain at most once. An empty array configures no hosted providers. |
| `chainId` | JSON integer: `1`, `10`, `8453`, `42161`, `84532`, `421614`, `11155111` or `11155420`. |
| `bundlerUrl`, `paymasterUrl` | Required fixed HTTPS endpoints, at most 4096 characters each; no userinfo, fragments, whitespace or control characters. Query-string API keys are private server configuration. |
| `paymasterPolicyId` | Required 1–128 character identifier using letters, digits, `.`, `_` or `-`; sent as `context.sponsorshipPolicyId`. |
| `sessionGuardAddress` | Optional nonzero contract address on this chain; live code must match the reviewed artifact before use. |
| `confirmations` | Optional JSON integer from 1 to 1024; default 1. This does not replace the finalized proof required to release a revoked session's allocation reservation. |
| `gas` | All eight fields in the example are required canonical unsigned decimal **strings**, without leading zeroes. Gas quantities are gas units, fee fields are wei per gas, and `maximumCost` is wei. |

Gas values must fit `uint128`, except `maximumCost`, which fits `uint256`. All are positive except `maximumPaymasterPostOpGas` and `maximumPriorityFeePerGas`, which may be zero. Priority fee cannot exceed total fee. Unknown keys, duplicate/unsupported chains, empty or oversized JSON (over 65,536 bytes), malformed endpoints and missing limits fail startup. Hosted execution always requires the reviewed paymaster. There is no switch to silently charge the wallet for gas.

Store the complete JSON in the deployment's secret store or a private environment file. A local private JSON file can be loaded without printing it:

```sh
export REST_ERC4337_CONFIG="$(cat /path/to/private/erc4337.json)"
npm run start
```

Never place that file in the website assets, a browser environment, a policy request, or a public repository. Startup errors deliberately omit provider URLs and credentials. The server accepts externally signed requests and operations; this configuration contains no owner/session private key.

The operator must create and fund an actual provider account, enable sponsorship for each chain, and obtain the endpoint credentials and policy identifier. The provider must return the source-bound legacy Pimlico V7 gas-only profile used by this stack: paymaster `0x0000000000000039cd5e8aE05257CE51C473ddd1`, runtime hash `0x1cd962f550282d1e4eadd0db10a956db2338c40f69c8b07cb434486275e1c11a`, packed paymaster data exactly 130 bytes with mode byte 52 equal to zero. This exact source interprets mode one as token charging. A different deployment, mode or signature layout is rejected even if supplied by the same provider brand. Sponsor allowance/deposit exhaustion fails execution; it does not authorize an owner-wallet debit. Provider provisioning and billing remain operator actions.

The `gas` values above bound server admission for individual operations. Each owner-approved session additionally binds onchain cumulative gas, conservative maximum-fee cost, operation count, expiry and action limits. Those onchain counters protect against a bot submitting directly to another bundler. Validation can consume counters even when execution subsequently reverts; do not credit those counters back in the database.

During unsigned gas estimation, Alto may replace the operation's seed gas values. The server can supply an internally generated `stateDiff` for five compiler-proven guard ceiling fields: per-operation gas, maximum fee, maximum priority fee, cumulative gas and cumulative sponsored cost. This temporary estimator context binds the exact chain, wallet, nonce, calldata and fees; callers cannot supply overrides. It changes no guard code, counters, paymaster identity, operation count or action policy. Final estimated fields must fit the original owner's remaining gas/cost/fee limits. Exact signed chain preflight runs without these overrides; an estimator result does not weaken the onchain policy or authorize submission by itself.

## Deploy and verify the guard

The reviewed package is `src/rest/smartAccounts/stack/contracts/CenterSessionGuard.sol`, `artifacts/CenterSessionGuard.json`, `manifest.json` and the adjacent evidence. The guard has no constructor arguments. Its reviewed runtime hash is:

```text
0x996eea0614de4cd5549d17464e0352745411666d42650b20b7a9252dfd1c328c
```

Run the release checks first. Set the selected chain, archive RPC URL and an existing Foundry keystore name in a private shell environment (`CENTER_CHAIN_ID`, `CENTER_RPC_URL`, `CENTER_DEPLOYER_KEYSTORE`). These commands do not import a key into the API server. Use the same reviewed compiler settings for deployment.

Prepare and inspect the deployment without broadcasting:

```sh
forge create contracts/CenterSessionGuard.sol:CenterSessionGuard \
  --root src/rest/smartAccounts/stack \
  --chain "$CENTER_CHAIN_ID" --rpc-url "$CENTER_RPC_URL" \
  --account "$CENTER_DEPLOYER_KEYSTORE"
```

After the operator authorizes this exact deployment, the following command **spends deployment gas and writes to the selected chain**:

```sh
forge create contracts/CenterSessionGuard.sol:CenterSessionGuard \
  --root src/rest/smartAccounts/stack \
  --chain "$CENTER_CHAIN_ID" --rpc-url "$CENTER_RPC_URL" \
  --account "$CENTER_DEPLOYER_KEYSTORE" --broadcast --json
```

Record the returned transaction hash and address as `CENTER_GUARD_DEPLOYMENT_TX` and `CENTER_GUARD_ADDRESS`. Keep the receipt, selected chain, source commit and artifact/manifest hashes in the deployment record. The following read-only check verifies the chain, successful creation receipt, exact creation bytecode, and runtime at that receipt's canonical block. It does not print the RPC endpoint. It requires Node 22 and the installed `viem` dependency.

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { isAddress, keccak256 } from 'viem';
const env = process.env;
const artifact = JSON.parse(await readFile('src/rest/smartAccounts/stack/artifacts/CenterSessionGuard.json', 'utf8'));
const chain = env.CENTER_CHAIN_ID;
const address = env.CENTER_GUARD_ADDRESS;
const transaction = env.CENTER_GUARD_DEPLOYMENT_TX;
if (!/^[1-9][0-9]*$/.test(chain ?? '') || !isAddress(address ?? '') ||
    !/^0x[0-9a-fA-F]{64}$/.test(transaction ?? '') || !env.CENTER_RPC_URL) {
  throw new Error('Set the exact chain, guard address, deployment transaction and private RPC URL.');
}
let id = 0;
async function rpc(method, params) {
  try {
    const response = await fetch(env.CENTER_RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}),
      signal: AbortSignal.timeout(15000)
    });
    const envelope = await response.json();
    if (!response.ok || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error();
    return envelope.result;
  } catch { throw new Error(`Verification RPC failed: ${method}`); }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain)) throw new Error('Wrong chain.');
const receipt = await rpc('eth_getTransactionReceipt', [transaction]);
const tx = await rpc('eth_getTransactionByHash', [transaction]);
if (!receipt || receipt.status !== '0x1' || !same(receipt.contractAddress, address) ||
    !same(receipt.transactionHash, transaction) || !tx || tx.to !== null ||
    !same(tx.blockHash, receipt.blockHash) || !same(tx.input, artifact.bytecode) || BigInt(tx.value) !== 0n) {
  throw new Error('Receipt or exact guard creation transaction does not match.');
}
const canonical = async () => {
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!block || !same(block.hash, receipt.blockHash)) throw new Error('Deployment block is not canonical.');
};
await canonical();
const code = await rpc('eth_getCode', [address, {blockHash: receipt.blockHash, requireCanonical: true}]);
if (code === '0x' || !same(keccak256(code), artifact.runtimeCodeHash)) throw new Error('Runtime does not match reviewed guard.');
await canonical();
console.log(JSON.stringify({chainId: chain, address, transaction, blockNumber: receipt.blockNumber,
  blockHash: receipt.blockHash, runtimeCodeHash: artifact.runtimeCodeHash, canonical: true}));
NODE
```

Repeat verification after the chosen confirmation/finality policy is satisfied. This receipt check is canonical evidence at one block, not a finality assertion. Add the verified address to that chain's `REST_ERC4337_CONFIG` and restart through the ordinary deployment process. Keep the checked source artifact's `address: null`: operator deployments belong in deployment records/configuration, not in a rewritten source provenance manifest. Runtime preparation and dispatch recheck live code; the JSON address alone never grants capability.

## Archive RPC and durable account history

The inspector needs `eth_chainId`, canonical block/transaction/receipt/log reads, EIP-1898 `eth_call`, `eth_getCode` and `eth_getStorageAt`, plus **`debug_traceTransaction` with `callTracer`, `onlyTopCall: false`**, for each source-proven transaction that can change account authority or session administration. The inspector checks canonical block membership, receipt identity and the complete nested trace against the transaction root. Unrelated transactions in the same block are not traced. Use an archive provider whose plan supports this method and historical range. A successful ordinary balance read or a provider's bundler endpoint does not prove trace support.

The trace path is private server infrastructure; do not enable arbitrary public debug RPC to make inspection work. Normal startup selects Dwellir chain endpoints through `DWELLIR_API_KEY`; an embedded host can supply reviewed fixed `upstreams`. Public fallback endpoints are not assumed to provide complete traces. Unsupported methods, partial traces, an unknown account initializer, unexpected modules/delegatecalls/fallbacks, exhausted history bounds, and reorgs fail inspection rather than weakening the proof.

Production uses `PostgresSafe7579CheckpointStore` and migration `010_rest_smart_account_checkpoints.sql`. Preserve checkpoints together with the account, session and UserOperation tables in backups. Checkpoints bind chain, wallet, manifest revision, utility hash, canonical creation, authority history and session-administration epoch. The inspector rechecks a retained checkpoint's canonical block and creation before reuse, falls back to retained earlier history where possible, and otherwise rebuilds or fails closed. Never insert a client-provided checkpoint or manually reset an administration epoch to resolve an activation error.

The default store retains 32 buckets of 128 blocks per wallet/manifest namespace and allows 10,000 namespaces. The inspector separately bounds relevant traced blocks, log requests, trace frames and request time. Monitor `SMART_TRACE_REQUIRED`, `SMART_HISTORY_LIMIT`, `SMART_HISTORY_INCOMPLETE`, `SMART_HISTORY_REORG` and checkpoint-capacity errors. Raising reviewed operator limits or providing complete historical data can restore availability; deleting proof state does not make a wallet safe to use.

## Bring-up and recovery

`GET /healthz` checks that the HTTP process responds; `GET /readyz` checks the database. Neither verifies a live sponsor. Inspect `GET /api/v1/capabilities` and `GET /api/v1/smart-accounts/capabilities` for configured chains, providers, manifests and execution requirements. Provider configuration appearing there is not a successful sponsorship quote. Preparation checks the bundler's chain and EntryPoint support, gets and estimates the exact sponsor data, and verifies the paymaster before asking a wallet to sign.

The default target resolver derives V6 controllers and terminals from the checked deployment catalog, verifies their exact source/runtime and canonical project association at the wallet binding's block, and rejects missing source proof. Native ETH uses the reviewed V6 sentinel and 18 decimals on all eight chains; mainnet ETH and testnet ETH have separate asset identities. Additional ERC20 support requires operator-reviewed immutable token targets and asset identities (`smartAccountSessionTargets` and `smartAccountAssets` in `createRestRuntime`). Target entries bind chain, address, runtime, action kind and review identity; asset entries bind chain/address to common asset identity and decimals. Arbitrary proxies, caller-supplied symbols, transfer-fee/rebasing behavior and unknown token implementations are not inferred to be safe. Cross-chain allocation groups must use reviewed equivalent units, with distinct per-chain allocations whose sum is within the owner's approved total.

Use the [smart-account guide](/api/docs/smart-accounts) and [session flow](/api/docs/sessions) for the owner/bot API sequence: create the verified wallet, bind its current owner to the API account, prepare a seven- or thirty-day policy, review and sign the exact owner activation, verify installed state, then prepare/sign/submit individual sponsored operations. A session allows one canonical inner call per operation; multiple authorized actions may belong to the session. Financial actions outside that policy require fresh owner approval. API grants must not be substituted for onchain expiry or budget enforcement.

To stop recurring authority durably, submit the prepared owner revocation containing both `removeSession` and `revokeEnableSignature`, then verify it canonically. API unlink or bot-grant revocation stops the API path but does not revoke a key's direct onchain authority. The service releases an overlapping allocation reservation only after the required finalized disabled/nonce-advanced proof. Renewal uses a new generation and salt after the permitted transition. A counter reset poisons the old session rather than restoring its allowance.

After a provider timeout, inspect the stored operation and canonical receipt before deciding what to submit next. Preserve exact signed operation identity; the service does not automatically resubmit, invent a replacement signature, or fall back to an EOA. Sponsor depletion or an unsupported provider profile requires operator repair and fresh preparation. No live deployment, sponsorship account, credential, or production payment is established by passing the local tests.
