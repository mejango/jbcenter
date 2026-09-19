import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  recoverMessageAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { RestBlockEvidence, RestRpc } from "../core.js";
import { assertSafe7579Execution } from "../smartAccounts/accountExecution.js";
import { CURRENT_PIMLICO_PAYMASTER } from "../smartAccounts/stack/current-pimlico/pins.js";
import {
  assertUserOperationGasPolicy,
  getUserOperationHash,
  normalizeUserOperation,
  packUserOperation,
  uoBytes,
  uoError,
  uoHash,
  uoObject,
  uoQuantity,
  USER_OPERATION_LIMITS,
  userOperationCommitment,
  userOperationMaximumCost,
} from "./codec.js";
import type { UserOperationProvider } from "./provider.js";
import type {
  UserOperationCodePin,
  UserOperationExecutionBinding,
  UserOperationGasPolicy,
  UserOperationPreflight,
} from "./types.js";

export const ENTRY_POINT_V07_ABI = parseAbi([
  "function getNonce(address sender,uint192 key) view returns(uint256)",
  "function balanceOf(address account) view returns(uint256)",
  "function entryPoint() view returns(address)",
  "function isBundlerAllowed(address bundler) view returns(bool)",
  "function signers(address signer) view returns(bool)",
  "function getHash(uint8 mode,(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns(bytes32)",
  "function validatePaymasterUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp,bytes32 userOpHash,uint256 maxCost) returns(bytes context,uint256 validationData)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns(bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
  "event BeforeExecution()",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)",
]);
// A reviewed immutable contract (today only the EntryPoint) cannot change code once deployed, so
// its runtime is proven against its pin once per process for ten minutes. An account's own proxy
// code and the per-account passkey signer are never kept: they are read live at every head.
const pinnedRuntimeMs = 600_000;
const pinnedRuntimes = new Map<string, number>();

export class UserOperationChain {
  private remaining = USER_OPERATION_LIMITS.rpcCalls;
  private readonly signal: AbortSignal;
  constructor(
    private readonly rpc: RestRpc,
    options: {
      signal?: AbortSignal;
      now?: () => number;
      timeoutMs?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10_000
    )
      uoError(
        "INVALID_USER_OPERATION_POLICY",
        "RPC timeout must be bounded.",
        500,
      );
    const deadline = AbortSignal.timeout(60_000);
    this.signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
  }
  private readonly now: () => number;
  private readonly timeoutMs: number;
  async request(
    chainId: number,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    this.check();
    if (--this.remaining < 0)
      uoError(
        "USER_OPERATION_RPC_BUDGET",
        "User-operation RPC budget exhausted.",
        429,
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error()), {
        once: true,
      });
      timer = setTimeout(abort, this.timeoutMs);
    });
    if (this.signal.aborted) abort();
    try {
      return await Promise.race([
        this.rpc.request(chainId, method, params, controller.signal),
        stopped,
      ]);
    } catch (error) {
      this.check();
      // The public error stays generic; the log names the read and the provider's error class
      // (and a revert selector) so an operator can tell a timeout from a rejected simulation.
      const failure = error as { code?: unknown; rpcCode?: unknown; data?: unknown; name?: unknown } | null;
      console.info(JSON.stringify({ service: "user-operations", action: "chain_rpc", outcome: "failed", method,
        code: typeof failure?.code === "string" ? failure.code : String(failure?.name ?? "unknown"),
        ...(typeof failure?.rpcCode === "number" ? { rpcCode: failure.rpcCode } : {}),
        ...(typeof failure?.data === "string" ? { selector: failure.data.slice(0, 10) } : {}) }));
      return uoError(
        "USER_OPERATION_RPC_UNAVAILABLE",
        "The configured chain could not verify or simulate this operation.",
        502,
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.signal.removeEventListener("abort", abort);
      abort();
    }
  }
  check(): void {
    if (this.signal.aborted)
      uoError(
        "USER_OPERATION_CANCELLED",
        "The user operation request was interrupted.",
        499,
      );
  }
  tag(evidence: RestBlockEvidence) {
    return { blockHash: evidence.blockHash, requireCanonical: true };
  }
  async snapshot(chainId: number): Promise<RestBlockEvidence> {
    return (await this.latest(chainId)).evidence;
  }
  /** The canonical head, with the base fee its block carries so pricing needs no second read. */
  /** The head as evidence, for a caller that pins other reads to it. */
  async head(chainId: number): Promise<{ evidence: RestBlockEvidence; baseFeePerGas: unknown }> { return this.latest(chainId); }
  private async latest(chainId: number): Promise<{ evidence: RestBlockEvidence; baseFeePerGas: unknown }> {
    const [chain, block] = await Promise.all([
      this.request(chainId, "eth_chainId", []),
      this.request(chainId, "eth_getBlockByNumber", ["latest", false]),
    ]);
    if (uoQuantity(chain, "RPC chain") !== BigInt(chainId) || !uoObject(block))
      uoError(
        "USER_OPERATION_CHAIN_MISMATCH",
        "The configured RPC did not establish the expected chain.",
        502,
      );
    const timestamp = uoQuantity(block.timestamp, "block timestamp");
    const now = BigInt(Math.floor(this.now() / 1000));
    if (timestamp > now + 30n || timestamp + 300n < now)
      uoError(
        "USER_OPERATION_STALE_CHAIN",
        "The canonical chain observation is stale.",
        502,
      );
    return { evidence: {
      chainId,
      blockNumber: uoQuantity(block.number, "block number").toString(),
      blockHash: uoHash(block.hash, "block hash"),
      timestamp: timestamp.toString(),
      source: "onchain",
    }, baseFeePerGas: block.baseFeePerGas };
  }
  /** The EntryPoint's own validation of the exact signed bytes, simulated at the verified head from
   * the origin the preflight chose: the one preflight check that needs the signature. */
  async validateSigned(binding: UserOperationExecutionBinding, evidence: RestBlockEvidence, from: Address): Promise<void> {
    const op = normalizeUserOperation(binding.operation);
    if (op.signature === "0x") uoError("USER_OPERATION_SIGNATURE_REQUIRED", "The exact external account signature is required.", 400);
    const totalGas = BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + BigInt(op.preVerificationGas) +
      BigInt(op.paymasterVerificationGasLimit ?? "0x0") + BigInt(op.paymasterPostOpGasLimit ?? "0x0");
    const validationResult = await this.request(binding.chainId, "eth_call", [
      { from, to: binding.entryPoint.address,
        data: encodeFunctionData({ abi: ENTRY_POINT_V07_ABI, functionName: "handleOps",
          args: [[packUserOperation(op)], "0x000000000000000000000000000000000000dEaD"] }),
        gas: toHex(totalGas + totalGas / 4n + 200_000n) },
      this.tag(evidence)]);
    if (validationResult !== "0x")
      uoError(
        "USER_OPERATION_SIMULATION_RESULT",
        "The exact EntryPoint validation returned an invalid simulation result.",
        502,
      );
    await this.canonical(evidence);
  }
  async canonical(evidence: RestBlockEvidence): Promise<void> {
    const block = await this.request(evidence.chainId, "eth_getBlockByNumber", [
      toHex(BigInt(evidence.blockNumber)),
      false,
    ]);
    if (
      !uoObject(block) ||
      uoHash(block.hash, "canonical block hash") !==
        evidence.blockHash.toLowerCase() ||
      uoQuantity(block.number, "canonical block number").toString() !==
        evidence.blockNumber ||
      uoQuantity(block.timestamp, "canonical timestamp").toString() !==
        evidence.timestamp
    )
      uoError(
        "USER_OPERATION_REORGED",
        "The observed block is no longer canonical.",
        409,
      );
  }
  async runtime(
    chainId: number,
    pin: UserOperationCodePin,
    evidence: RestBlockEvidence,
    /** A reviewed immutable contract, proven once per process rather than at every head. */
    pinned = false,
  ): Promise<void> {
    const key = `${chainId}:${pin.address.toLowerCase()}:${pin.runtimeCodeHash.toLowerCase()}`;
    if (pinned && (pinnedRuntimes.get(key) ?? 0) > this.now()) return;
    const code = uoBytes(
      await this.request(chainId, "eth_getCode", [
        pin.address,
        this.tag(evidence),
      ]),
      "contract runtime",
      49_152,
    );
    if (code === "0x" || keccak256(code) !== pin.runtimeCodeHash.toLowerCase())
      uoError(
        "USER_OPERATION_RUNTIME_MISMATCH",
        "A required deployed contract differs from its reviewed runtime.",
      );
    if (pinned) pinnedRuntimes.set(key, this.now() + pinnedRuntimeMs);
  }
  async nonce(
    chainId: number,
    sender: Address,
    key: bigint,
    entryPoint: UserOperationCodePin,
    /** A head this caller already read; otherwise the current one is read here. */
    head?: Promise<{ evidence: RestBlockEvidence; baseFeePerGas: unknown }>,
  ): Promise<{ nonce: Hex; evidence: RestBlockEvidence; baseFeePerGas: unknown }> {
    if (key < 0n || key >= 1n << 192n)
      uoError(
        "INVALID_USER_OPERATION_NONCE",
        "The keyed nonce must fit uint192.",
        400,
      );
    const { evidence, baseFeePerGas } = await (head ?? this.latest(chainId));
    await this.runtime(chainId, entryPoint, evidence, true);
    // The read is pinned to the head's hash and requires it canonical, so the node itself refuses
    // a head that a reorg has replaced; no second block read is needed to know.
    const nonce = await this.readNonce(
      chainId,
      sender,
      key,
      entryPoint.address,
      evidence,
    );
    return { nonce: toHex(nonce), evidence, baseFeePerGas };
  }
  private async call(
    chainId: number,
    to: Address,
    data: Hex,
    evidence: RestBlockEvidence,
  ): Promise<Hex> {
    return uoBytes(
      await this.request(chainId, "eth_call", [
        { to, data, gas: "0x1e8480" },
        this.tag(evidence),
      ]),
      "contract result",
      65_536,
    );
  }
  /** The EntryPoint's full nonce for `sender` under `key` at the given canonical block. */
  async readNonce(
    chainId: number,
    sender: Address,
    key: bigint,
    entryPoint: Address,
    evidence: RestBlockEvidence,
  ): Promise<bigint> {
    const data = await this.call(
      chainId,
      entryPoint,
      encodeFunctionData({
        abi: ENTRY_POINT_V07_ABI,
        functionName: "getNonce",
        args: [sender, key],
      }),
      evidence,
    );
    return decodeFunctionResult({
      abi: ENTRY_POINT_V07_ABI,
      functionName: "getNonce",
      data,
    });
  }
  /** Exact external signature and both validation/execution paths are simulated; nothing is broadcast. */
  async preflight(
    binding: UserOperationExecutionBinding,
    gasPolicy: UserOperationGasPolicy,
    provider?: UserOperationProvider,
    /** A head the caller already verified the account at; otherwise the current head. */
    at?: RestBlockEvidence,
    /** `signed: false` runs everything but the EntryPoint validation of the exact signed bytes,
     * which `validateSigned` runs later at the same head once the signature exists. */
    options: { signed?: boolean } = {},
  ): Promise<UserOperationPreflight> {
    const op = normalizeUserOperation(binding.operation);
    if (op.signature === "0x")
      uoError(
        "USER_OPERATION_SIGNATURE_REQUIRED",
        "The exact external account signature is required.",
        400,
      );
    if (op.factory)
      uoError(
        "USER_OPERATION_ACCOUNT_UNDEPLOYED",
        "Deploy and verify the account before this execution transport is used.",
      );
    if (binding.accountCode.address.toLowerCase() !== op.sender)
      uoError(
        "USER_OPERATION_ACCOUNT_MISMATCH",
        "The operation sender differs from the verified account.",
      );
    if (
      binding.calls.length < 1 ||
      binding.calls.some((call) => call.chainId !== binding.chainId)
    )
      uoError(
        "USER_OPERATION_CALL_MISMATCH",
        "Every planned call must belong to this destination chain.",
      );
    assertSafe7579Execution(
      op.callData,
      binding.calls.map((call) => ({
        target: call.to,
        value: call.value,
        callData: call.data,
      })),
    );
    assertUserOperationGasPolicy(op, gasPolicy);
    const evidence = at ?? (await this.snapshot(binding.chainId));
    const operationHash = getUserOperationHash(
      op,
      binding.entryPoint.address,
      binding.chainId,
    );
    if (operationHash !== binding.operationHash.toLowerCase())
      uoError(
        "USER_OPERATION_HASH_MISMATCH",
        "The operation differs from its immutable draft hash.",
      );
    const nonce = BigInt(op.nonce);
    const key = nonce >> 64n;
    // What the sponsor path needs is decided locally first, so the reads of the preflight go out
    // at once: all are pinned to the same block and independent of each other. Behind them, as
    // before: the sponsor's signer (it needs the sponsor hash), then the two simulations, which
    // run only once the sponsorship is authenticated and the payer funded. The checks below run
    // over the results in the order they always ran.
    const packed = packUserOperation(op);
    const entryPointCall = (functionName: "getUserOpHash" | "balanceOf", args: readonly unknown[]) =>
      this.call(binding.chainId, binding.entryPoint.address, encodeFunctionData({ abi: ENTRY_POINT_V07_ABI, functionName, args } as never), evidence);
    const paymasterCall = (functionName: "entryPoint" | "isBundlerAllowed" | "getHash", args: readonly unknown[] = []) =>
      this.call(binding.chainId, op.paymaster!, encodeFunctionData({ abi: ENTRY_POINT_V07_ABI, functionName, args } as never), evidence);
    let configured: ReturnType<UserOperationProvider["configuration"]> | undefined;
    let restricted: { bundler: Address; signature: string } | undefined;
    let paymasterProof;
    let simulationFrom: Address = "0x000000000000000000000000000000000000dEaD";
    if (op.paymaster) {
      configured = provider?.configuration(binding.chainId);
      if (!provider || !configured?.paymasterPolicy)
        uoError(
          "USER_OPERATION_PAYMASTER_UNAVAILABLE",
          "This paymaster has no reviewed provider policy.",
        );
      if (
        configured.entryPoint.address.toLowerCase() !==
          binding.entryPoint.address.toLowerCase() ||
        configured.entryPoint.runtimeCodeHash.toLowerCase() !==
          binding.entryPoint.runtimeCodeHash.toLowerCase()
      )
        uoError(
          "USER_OPERATION_PROVIDER_MISMATCH",
          "The provider and execution EntryPoint pins differ.",
        );
      paymasterProof = provider.inspectPaymaster(binding.chainId, op, "final");
      if (configured.paymasterPolicy.profile === "pimlico-v7-current-flags" && op.paymasterData?.slice(2, 4) === "00") {
        // This source's flag 00 checks tx.origin. A direct paymaster call from
        // EntryPoint cannot represent an allowed bundler origin. Authenticate
        // its exact verifying-mode signature from the pinned getHash/signers
        // implementation, then run the complete real handleOps below.
        const bundler = configured.simulationBundlerAddress;
        if (!bundler || !isAddress(bundler) || BigInt(bundler) === 0n)
          uoError("USER_OPERATION_BUNDLER_ORIGIN_REQUIRED",
            "Restricted sponsorship requires an operator-configured simulation bundler address.");
        if (op.paymaster !== CURRENT_PIMLICO_PAYMASTER.address ||
            configured.paymasterPolicy.contract.runtimeCodeHash !== CURRENT_PIMLICO_PAYMASTER.runtimeCodeHash ||
            op.paymasterData.length !== 158)
          uoError("USER_OPERATION_PAYMASTER_MISMATCH", "The restricted sponsor differs from its reviewed deployment.");
        const signature = op.paymasterData.slice(28);
        const s = BigInt(`0x${signature.slice(64, 128)}`), v = Number(BigInt(`0x${signature.slice(128, 130)}`));
        if (s === 0n || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n || (v !== 27 && v !== 28))
          uoError("USER_OPERATION_PAYMASTER_SIGNATURE", "The sponsor signature is not canonical OpenZeppelin ECDSA data.");
        restricted = { bundler, signature };
        simulationFrom = bundler;
      }
    }
    const pimlico = configured?.paymasterPolicy?.profile === "pimlico-v7-legacy-mode" || configured?.paymasterPolicy?.profile === "pimlico-v7-current-flags";
    const payer = op.paymaster ?? op.sender;
    const totalGas =
      BigInt(op.callGasLimit) +
      BigInt(op.verificationGasLimit) +
      BigInt(op.preVerificationGas) +
      BigInt(op.paymasterVerificationGasLimit ?? "0x0") +
      BigInt(op.paymasterPostOpGasLimit ?? "0x0");
    const reads = await Promise.allSettled([
      this.runtime(binding.chainId, binding.entryPoint, evidence, true),
      this.runtime(binding.chainId, binding.accountCode, evidence),
      this.readNonce(binding.chainId, op.sender, key, binding.entryPoint.address, evidence),
      entryPointCall("getUserOpHash", [packed]),
      op.paymaster ? this.runtime(binding.chainId, configured!.paymasterPolicy!.contract, evidence) : undefined,
      op.paymaster && pimlico ? paymasterCall("entryPoint") : undefined,
      restricted ? this.request(binding.chainId, "eth_getCode", [restricted.bundler, this.tag(evidence)]) : undefined,
      restricted ? paymasterCall("isBundlerAllowed", [restricted.bundler]) : undefined,
      restricted ? paymasterCall("getHash", [0, packed]) : undefined,
      op.paymaster && pimlico && !restricted
        ? this.request(binding.chainId, "eth_call", [
            { from: binding.entryPoint.address, to: op.paymaster,
              data: encodeFunctionData({ abi: ENTRY_POINT_V07_ABI, functionName: "validatePaymasterUserOp",
                args: [packed, operationHash, userOperationMaximumCost(op)] }),
              gas: op.paymasterVerificationGasLimit },
            this.tag(evidence)])
        : undefined,
      entryPointCall("balanceOf", [payer]),
      op.paymaster ? undefined : this.request(binding.chainId, "eth_getBalance", [op.sender, this.tag(evidence)]),
    ] as const);
    // A read that failed is reported in the order the checks ran, before any later check.
    const read = <T>(index: number): T => {
      const outcome = reads[index]!;
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value as T;
    };
    read(0); read(1);
    const currentNonce = read<bigint>(2), onchainHash = read<Hex>(3);
    if (currentNonce !== nonce)
      uoError(
        "USER_OPERATION_NONCE_CHANGED",
        "The current keyed nonce changed; prepare a fresh operation.",
        409,
      );
    if (
      decodeFunctionResult({
        abi: ENTRY_POINT_V07_ABI,
        functionName: "getUserOpHash",
        data: onchainHash,
      }).toLowerCase() !== operationHash
    )
      uoError(
        "USER_OPERATION_HASH_MISMATCH",
        "Local and deployed EntryPoint v0.7 hashes do not agree.",
      );
    if (op.paymaster) {
      read(4);
      if (pimlico) {
        if (
          decodeFunctionResult({
            abi: ENTRY_POINT_V07_ABI,
            functionName: "entryPoint",
            data: read<Hex>(5),
          }).toLowerCase() !== binding.entryPoint.address.toLowerCase()
        )
          uoError(
            "USER_OPERATION_PAYMASTER_MISMATCH",
            "The pinned paymaster is configured for another EntryPoint.",
          );
        if (!restricted) {
          const data = uoBytes(read(9), "paymaster validation result", 4096);
          const [context, validation] = decodeFunctionResult({
            abi: ENTRY_POINT_V07_ABI,
            functionName: "validatePaymasterUserOp",
            data,
          });
          const until = (validation >> 160n) & ((1n << 48n) - 1n);
          const after = validation >> 208n;
          const time = BigInt(Math.floor(this.now() / 1000));
          if (
            context !== "0x" ||
            (validation & ((1n << 160n) - 1n)) !== 0n ||
            after > time ||
            (until !== 0n && until <= time + 30n)
          )
            uoError(
              "USER_OPERATION_PAYMASTER_SIGNATURE",
              "The deployed gas-only paymaster rejected the exact sponsorship signature or validity window.",
            );
        } else {
          const [bundlerCode, allowedResult, hashResult] = [read<Hex>(6), read<Hex>(7), read<Hex>(8)];
          if (bundlerCode !== "0x" || !decodeFunctionResult({
            abi: ENTRY_POINT_V07_ABI, functionName: "isBundlerAllowed", data: allowedResult,
          }))
            uoError("USER_OPERATION_BUNDLER_ORIGIN_UNVERIFIED",
              "The configured simulation origin must be an allowed EOA at the verified block.");
          const sponsorHash = decodeFunctionResult({ abi: ENTRY_POINT_V07_ABI, functionName: "getHash", data: hashResult });
          let recovered: Address;
          try {
            recovered = await recoverMessageAddress({ message: { raw: sponsorHash }, signature: `0x${restricted.signature}` });
          } catch {
            return uoError("USER_OPERATION_PAYMASTER_SIGNATURE", "The sponsor signature cannot authenticate this exact operation.");
          }
          const signerResult = await this.call(binding.chainId, op.paymaster, encodeFunctionData({
            abi: ENTRY_POINT_V07_ABI, functionName: "signers", args: [recovered],
          }), evidence);
          const time = Math.floor(this.now() / 1000);
          if (BigInt(recovered) === 0n || !decodeFunctionResult({
            abi: ENTRY_POINT_V07_ABI, functionName: "signers", data: signerResult,
          }) || paymasterProof!.validAfter > time || paymasterProof!.validUntil <= time + 30)
            uoError("USER_OPERATION_PAYMASTER_SIGNATURE",
              "The deployed gas-only paymaster rejected the exact sponsorship signature or validity window.");
        }
      }
    }
    const deposit = decodeFunctionResult({
      abi: ENTRY_POINT_V07_ABI,
      functionName: "balanceOf",
      data: read<Hex>(10),
    });
    const maximumCost = userOperationMaximumCost(op);
    const walletFunds = op.paymaster
      ? 0n
      : uoQuantity(read(11), "account native balance");
    const plannedValue = binding.calls.reduce(
      (sum, call) => sum + BigInt(call.value),
      0n,
    );
    if (
      deposit + walletFunds <
      maximumCost + (op.paymaster ? 0n : plannedValue)
    )
      uoError(
        "USER_OPERATION_FUNDING_REQUIRED",
        "The configured gas payer cannot cover the reviewed maximum execution cost.",
      );
    // handleOps catches inner execution failures. Its success alone therefore
    // cannot establish readiness: independently simulate the exact atomic call.
    const [executionResult] = await Promise.all([
      this.request(binding.chainId, "eth_call", [
        { from: binding.entryPoint.address, to: op.sender, data: op.callData, gas: op.callGasLimit },
        this.tag(evidence)]),
      options.signed === false ? undefined : this.validateSigned(binding, evidence, simulationFrom),
    ]);
    if (executionResult !== "0x")
      uoError(
        "USER_OPERATION_SIMULATION_RESULT",
        "The exact account execution returned an invalid simulation result.",
        502,
      );
    await this.canonical(evidence);
    this.check();
    if (provider && paymasterProof)
      paymasterProof = provider.inspectPaymaster(binding.chainId, op, "final");
    return {
      operationHash,
      signedCommitment: userOperationCommitment(
        op,
        binding.entryPoint.address,
        binding.chainId,
      ),
      evidence,
      maximumCost: maximumCost.toString(),
      nonceKey: key.toString(),
      validationOrigin: simulationFrom,
      nonceSequence: (nonce & ((1n << 64n) - 1n)).toString(),
      ...(paymasterProof ? { paymasterProof } : {}),
    };
  }
}
