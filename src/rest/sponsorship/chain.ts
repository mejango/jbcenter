import {
  decodeFunctionResult,
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type { ContractCatalog } from "../contracts/catalog.js";
import type { RestBlockEvidence, RestCall, RestRpc } from "../core.js";
import { rpcHex, verifyRuntime } from "../protocol/code.js";
import {
  FORWARDER_ABI,
  FORWARD_REQUEST_TYPES,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_CODE_HASH,
  RELAYR_PAYMENT_GAS,
  RELAYR_LIMITS,
} from "./constants.js";
import type {
  PreparedForwardRequest,
  RelayrEntry,
  RelayrPayment,
  SponsorshipPolicy,
} from "./types.js";
import {
  assertSignal,
  decimal,
  fail,
  hash,
  hex,
  object,
  quantity,
  same,
} from "./validation.js";

/** A request owns one call budget and forwards cancellation to the configured RPC. */
export class SponsorshipChain {
  private remaining = 128 + 24 * RELAYR_LIMITS.maximumCalls;
  constructor(
    private readonly rpc: RestRpc,
    private readonly policy: SponsorshipPolicy,
    private readonly signal?: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}
  async request(
    chainId: number,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    assertSignal(this.signal);
    if (--this.remaining < 0)
      fail(
        "SPONSORSHIP_RPC_BUDGET",
        "Sponsorship request exhausted its RPC budget.",
        429,
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("RPC interrupted")),
        { once: true },
      );
      timer = setTimeout(abort, this.policy.rpcTimeoutMs);
    });
    if (this.signal?.aborted) abort();
    try {
      return await Promise.race([
        this.rpc.request(chainId, method, params, controller.signal),
        stopped,
      ]);
    } catch {
      assertSignal(this.signal);
      return fail(
        "SPONSORSHIP_RPC_UNAVAILABLE",
        "The configured RPC could not verify or simulate the exact sponsorship request.",
        502,
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  async snapshot(chainId: number): Promise<RestBlockEvidence> {
    const [chain, block] = await Promise.all([
      this.request(chainId, "eth_chainId", []),
      this.request(chainId, "eth_getBlockByNumber", ["latest", false]),
    ]);
    if (
      quantity(chain, "chain ID") !== BigInt(chainId) ||
      !object(block) ||
      !hash(block.hash)
    )
      return fail(
        "SPONSORSHIP_CHAIN_MISMATCH",
        "RPC did not establish the configured chain and canonical block.",
        502,
      );
    const timestamp = quantity(block.timestamp, "block timestamp");
    if (
      timestamp > BigInt(Math.floor(this.now() / 1000) + 30) ||
      timestamp + 300n < BigInt(Math.floor(this.now() / 1000))
    )
      fail(
        "SPONSORSHIP_STALE_CHAIN",
        "The chain observation is too old or ahead of the server clock.",
        502,
      );
    return {
      chainId,
      blockHash: block.hash,
      blockNumber: quantity(block.number, "block number").toString(),
      timestamp: timestamp.toString(),
      source: "onchain",
    };
  }
  tag(evidence: RestBlockEvidence) {
    return { blockHash: evidence.blockHash, requireCanonical: true };
  }
  async canonical(evidence: RestBlockEvidence): Promise<void> {
    const block = await this.request(evidence.chainId, "eth_getBlockByNumber", [
      hex(decimal(evidence.blockNumber, "block number")),
      false,
    ]);
    if (
      !object(block) ||
      !hash(block.hash) ||
      !same(block.hash, evidence.blockHash) ||
      quantity(block.number, "block number").toString() !==
        evidence.blockNumber ||
      quantity(block.timestamp, "timestamp").toString() !== evidence.timestamp
    )
      fail(
        "SPONSORSHIP_REORGED",
        "The observed block changed. Prepare or reconcile against canonical state.",
        409,
      );
  }
  async call(
    chainId: number,
    to: Address,
    data: Hex,
    evidence: RestBlockEvidence,
  ): Promise<Hex> {
    return rpcHex(
      await this.request(chainId, "eth_call", [
        { to, data, gas: "0xf4240" },
        this.tag(evidence),
      ]),
      "Contract response",
      16_384,
    );
  }
  async nonce(
    chainId: number,
    forwarder: Address,
    owner: Address,
    evidence: RestBlockEvidence,
  ): Promise<string> {
    const value = await this.call(
      chainId,
      forwarder,
      encodeFunctionData({
        abi: FORWARDER_ABI,
        functionName: "nonces",
        args: [owner],
      }),
      evidence,
    );
    return (
      decodeFunctionResult({
        abi: FORWARDER_ABI,
        functionName: "nonces",
        data: value,
      }) as bigint
    ).toString();
  }
  async prepare(
    catalog: ContractCatalog,
    call: RestCall,
    account: Address,
    stepIndex: number,
    deadline: number,
  ): Promise<PreparedForwardRequest> {
    if (
      !isAddress(account) ||
      !isAddress(call.to) ||
      typeof call.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data) ||
      call.data.length > 131_074
    )
      fail(
        "INVALID_FORWARD_REQUEST",
        "The immutable planned call is not a bounded transaction.",
        400,
      );
    decimal(call.value, "native value");
    const candidates = catalog
      .list({ chainId: call.chainId, deployedOnly: true })
      .filter(
        (contract) =>
          contract.name === "ERC2771Forwarder" && contract.executable,
      )
      .flatMap((contract) =>
        contract.deployments
          .filter((chain) => chain.chainId === call.chainId)
          .flatMap((chain) => chain.instances),
      );
    if (candidates.length !== 1)
      return fail(
        "FORWARDER_UNAVAILABLE",
        "The V6 manifest does not uniquely identify this chain’s forwarder.",
      );
    const deployment = candidates[0]!;
    const evidence = await this.snapshot(call.chainId);
    const [forwarderCode, targetCode, ownerCode] = await Promise.all([
      this.request(call.chainId, "eth_getCode", [
        deployment.address,
        this.tag(evidence),
      ]),
      this.request(call.chainId, "eth_getCode", [call.to, this.tag(evidence)]),
      this.request(call.chainId, "eth_getCode", [account, this.tag(evidence)]),
    ]);
    const forwarderCodeHash = verifyRuntime(
      rpcHex(forwarderCode, "Forwarder runtime"),
      catalog.code(deployment.codeId),
    ).runtimeCodeHash;
    const target = rpcHex(targetCode, "Target runtime");
    if (target === "0x")
      fail(
        "FORWARDER_TARGET_UNAVAILABLE",
        "The planned target has no runtime code.",
      );
    const owner = rpcHex(ownerCode, "Account runtime", 24_576);
    if (owner !== "0x" && !/^0xef0100[0-9a-f]{40}$/.test(owner))
      fail(
        "FORWARDER_ACCOUNT_UNSUPPORTED",
        "This forwarder requires the wallet’s ECDSA signature. Safe and ERC1271 execution need a separate account adapter.",
      );
    const [domainData, nonce, trustData] = await Promise.all([
      this.call(
        call.chainId,
        deployment.address,
        encodeFunctionData({
          abi: FORWARDER_ABI,
          functionName: "eip712Domain",
        }),
        evidence,
      ),
      this.nonce(call.chainId, deployment.address, account, evidence),
      this.call(
        call.chainId,
        call.to,
        encodeFunctionData({
          abi: FORWARDER_ABI,
          functionName: "isTrustedForwarder",
          args: [deployment.address],
        }),
        evidence,
      ),
    ]);
    const [
      fields,
      name,
      version,
      chainId,
      verifyingContract,
      salt,
      extensions,
    ] = decodeFunctionResult({
      abi: FORWARDER_ABI,
      functionName: "eip712Domain",
      data: domainData,
    });
    if (
      fields !== "0x0f" ||
      name !== "Juicebox" ||
      version !== "1" ||
      chainId !== BigInt(call.chainId) ||
      !same(verifyingContract, deployment.address) ||
      salt !== `0x${"0".repeat(64)}` ||
      extensions.length !== 0
    )
      fail(
        "FORWARDER_DOMAIN_MISMATCH",
        "The canonical forwarder returned an unexpected signing domain.",
      );
    if (
      !decodeFunctionResult({
        abi: FORWARDER_ABI,
        functionName: "isTrustedForwarder",
        data: trustData,
      })
    )
      fail(
        "FORWARDER_TARGET_UNTRUSTED",
        "The planned target does not trust the canonical V6 forwarder.",
      );
    const simulation = {
      from: account,
      to: call.to,
      data: call.data,
      value: hex(BigInt(call.value)),
    };
    await this.request(call.chainId, "eth_call", [
      { ...simulation, gas: hex(this.policy.maximumGas) },
      this.tag(evidence),
    ]);
    const estimated = quantity(
      await this.request(call.chainId, "eth_estimateGas", [
        simulation,
        hex(BigInt(evidence.blockNumber)),
      ]),
      "gas estimate",
    );
    const gas = (estimated * 12n) / 10n + 25_000n;
    if (gas > this.policy.maximumGas || gas <= 0n)
      fail(
        "FORWARDER_GAS_LIMIT",
        "The reviewed call exceeds the configured forwarding gas limit.",
      );
    await this.canonical(evidence);
    return {
      stepIndex,
      chainId: call.chainId,
      forwarder: deployment.address,
      forwarderCodeHash,
      targetCodeHash: keccak256(target),
      domain: {
        name,
        version,
        chainId: call.chainId,
        verifyingContract: deployment.address,
      },
      message: {
        from: account,
        to: call.to,
        value: call.value,
        gas: gas.toString(),
        nonce,
        deadline: String(deadline),
        data: call.data,
      },
      evidence,
    };
  }
  async signed(
    request: PreparedForwardRequest,
    signature: Hex,
    preceding: RelayrEntry[] = [],
  ): Promise<RelayrEntry> {
    if (
      typeof signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature)
    )
      fail(
        "INVALID_FORWARD_SIGNATURE",
        "Provide one 65-byte ECDSA signature for each exact request.",
        400,
      );
    const message = {
      ...request.message,
      value: BigInt(request.message.value),
      gas: BigInt(request.message.gas),
      nonce: BigInt(request.message.nonce),
      deadline: Number(request.message.deadline),
    };
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: request.domain,
        primaryType: "ForwardRequest",
        types: FORWARD_REQUEST_TYPES,
        message,
        signature,
      });
    } catch {
      return fail(
        "INVALID_FORWARD_SIGNATURE",
        "The supplied signature is not valid for this exact forward request.",
        400,
      );
    }
    if (!same(signer, message.from))
      fail(
        "FORWARD_SIGNATURE_ACCOUNT_MISMATCH",
        "API bot keys cannot replace the owner wallet’s transaction signature.",
        403,
      );
    const evidence = await this.revalidate(request, preceding.length);
    const { nonce: _nonce, ...withoutNonce } = message;
    const execution = { ...withoutNonce, signature };
    if (!preceding.length) {
      const verified = await this.call(
        request.chainId,
        request.forwarder,
        encodeFunctionData({ abi: FORWARDER_ABI, functionName: "verify", args: [execution] }),
        evidence,
      );
      if (!decodeFunctionResult({ abi: FORWARDER_ABI, functionName: "verify", data: verified }))
        fail("FORWARD_SIGNATURE_REJECTED", "The canonical forwarder rejected this signature or current nonce.");
    }
    const data = encodeFunctionData({
      abi: FORWARDER_ABI,
      functionName: "execute",
      args: [execution],
    });
    const entry: RelayrEntry = {
      chain: request.chainId, target: request.forwarder,
      value: request.message.value, data, virtual_nonce: preceding.length,
    };
    const calls = [...preceding, entry].map((item) => {
      const decoded = decodeFunctionData({ abi: FORWARDER_ABI, data: item.data });
      if (item.chain !== request.chainId || !same(item.target, request.forwarder) || decoded.functionName !== "execute")
        return fail("INVALID_FORWARD_SEQUENCE", "Forwarded calls must use the same chain and forwarder.", 400);
      const gas = decoded.args[0].gas;
      return { from: message.from, to: item.target, data: item.data,
        value: hex(BigInt(item.value)), gas: hex(gas + gas / 63n + 100_000n) };
    });
    if (!preceding.length) {
      await this.request(request.chainId, "eth_call", [calls[0], this.tag(evidence)]);
    } else {
      // Execute the exact individual calls in sequence. A batch forwarder call
      // can hide a zero-value inner revert, so it cannot establish this result.
      const result = await this.request(request.chainId, "eth_simulateV1", [
        { blockStateCalls: [{ calls }], validation: false }, hex(BigInt(evidence.blockNumber)),
      ]);
      if (!Array.isArray(result) || result.length !== 1 || !object(result[0]) ||
          !Array.isArray(result[0].calls) || result[0].calls.length !== calls.length ||
          result[0].calls.some((call) => !object(call) || call.status !== "0x1" || call.error !== undefined || call.returnData !== "0x"))
        fail("FORWARD_SEQUENCE_SIMULATION_FAILED", "The exact forwarded sequence could not be simulated successfully.");
    }
    await this.canonical(evidence);
    return entry;
  }
  async revalidate(
    request: PreparedForwardRequest,
    nonceOffset = 0,
  ): Promise<RestBlockEvidence> {
    if (
      Number(request.message.deadline) <=
      Math.floor(this.now() / 1000) + this.policy.minimumRemainingSeconds
    )
      fail(
        "FORWARD_REQUEST_EXPIRED",
        "The signed forwarding deadline expires too soon.",
        409,
      );
    const evidence = await this.snapshot(request.chainId);
    const [forwarderCode, targetCode, nonce, trust] = await Promise.all([
      this.request(request.chainId, "eth_getCode", [
        request.forwarder,
        this.tag(evidence),
      ]),
      this.request(request.chainId, "eth_getCode", [
        request.message.to,
        this.tag(evidence),
      ]),
      this.nonce(
        request.chainId,
        request.forwarder,
        request.message.from,
        evidence,
      ),
      this.call(
        request.chainId,
        request.message.to,
        encodeFunctionData({
          abi: FORWARDER_ABI,
          functionName: "isTrustedForwarder",
          args: [request.forwarder],
        }),
        evidence,
      ),
    ]);
    if (
      keccak256(rpcHex(forwarderCode, "Forwarder runtime")) !==
        request.forwarderCodeHash ||
      keccak256(rpcHex(targetCode, "Target runtime")) !==
        request.targetCodeHash ||
      BigInt(nonce) + BigInt(nonceOffset) !== BigInt(request.message.nonce) ||
      !decodeFunctionResult({
        abi: FORWARDER_ABI,
        functionName: "isTrustedForwarder",
        data: trust,
      })
    )
      fail(
        "FORWARD_REQUEST_CHANGED",
        "The forwarder, target, trust configuration or nonce changed after preparation.",
        409,
      );
    await this.canonical(evidence);
    return evidence;
  }
  async payment(
    payment: RelayrPayment,
    payer: Address,
  ): Promise<RestBlockEvidence> {
    if (!isAddress(payer))
      fail(
        "INVALID_FUNDING_PAYER",
        "Provide the exact wallet that will sign bundle funding.",
        400,
      );
    const evidence = await this.paymentRuntime(payment.chainId);
    const result = await this.request(payment.chainId, "eth_call", [
      {
        from: payer,
        to: payment.to,
        data: payment.data,
        value: hex(BigInt(payment.value)),
        gas: hex(RELAYR_PAYMENT_GAS),
      },
      this.tag(evidence),
    ]);
    if (result !== "0x")
      fail(
        "RELAYR_PAYMENT_SIMULATION",
        "The exact payment returned an unexpected simulation result.",
      );
    await this.canonical(evidence);
    return evidence;
  }
  async paymentRuntime(chainId: number): Promise<RestBlockEvidence> {
    const evidence = await this.snapshot(chainId);
    const code = rpcHex(
      await this.request(chainId, "eth_getCode", [
        RELAYR_PAYMENT_ADDRESS,
        this.tag(evidence),
      ]),
      "The execution service payment runtime",
      2048,
    );
    if (keccak256(code) !== RELAYR_PAYMENT_CODE_HASH)
      fail(
        "RELAYR_PAYMENT_RUNTIME",
        "The payment contract does not match the pinned immutable runtime.",
      );
    await this.canonical(evidence);
    return evidence;
  }
}
