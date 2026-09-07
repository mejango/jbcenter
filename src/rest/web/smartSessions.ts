import { getAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RestClientError,
  SignedRestClient,
  SmartAccountClient,
  assertReviewedOperation,
  assertWalletIdentity,
  newRequestNonce,
  ownerOperationSignature,
  ownerOperationSigning,
  packOwnerSignatures,
  readPublicRestJson,
  sessionActionPlanInput,
  signSessionUserOperation,
  signWalletTypedData,
  smartBindingDocument,
  smartRequestKey,
  verifyWalletCreation,
  type BindingChallenge,
  type BindingRequest,
  type PreparedUserOperation,
  type SmartAccountCapabilities,
  type WalletCreationPreparation,
  type WalletCreationRequest,
  type WalletProvider,
  type WalletTypedData,
  type SmartWalletPlan,
} from "../client/index.js";
import type {
  SessionPolicyInput,
  SmartAccountBinding,
  SmartAccountManifest,
} from "../smartAccounts/types.js";
import type { StoredSession } from "../sessions/types.js";

export interface SmartWalletConnection {
  provider: WalletProvider;
  owner: Address;
  chainId: number;
  accountId: string;
  client: SignedRestClient;
}
interface HostCapabilities {
  smartAccounts: SmartAccountCapabilities;
  userOperations?: {
    preparation?: boolean;
    relay?: boolean;
    providers?: {
      chainId: number;
      providerId: string;
      paymasterConfigured: boolean;
    }[];
    activationRequirements?: string[];
  };
}
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const field = (id: string) =>
  element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fail(message: string): never {
  throw new RestClientError("SMART_WALLET_REVIEW_REQUIRED", message);
}
const json = (id: string) => {
  const raw = field(id).value;
  if (raw.length > 65_536) fail("The review document is too large.");
  try {
    return JSON.parse(raw);
  } catch {
    return fail("Enter a valid JSON document.");
  }
};
const show = (id: string, value: unknown) => {
  const node = element(id);
  node.textContent = JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  node.hidden = false;
};
function address(id: string): Address {
  try {
    return getAddress(field(id).value.trim());
  } catch {
    return fail("Enter a complete Ethereum address.");
  }
}
function decimal(id: string): string {
  const value = field(id).value.trim();
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value))
    fail("Use whole decimal integers in raw token units or wei.");
  return value;
}
function signatureList(id: string): Hex[] {
  if (!field(id).value.trim()) return [];
  const list: unknown = json(id);
  if (
    !Array.isArray(list) ||
    list.length > 16 ||
    list.some((s) => typeof s !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s))
  )
    fail("Enter a JSON array of 65-byte owner signatures.");
  return list as Hex[];
}

/** Keys live only in this closure. Every request facade accepts public fields and signatures. */
export function installSmartWalletUI(options: {
  audience: string;
  connection(): SmartWalletConnection | undefined;
  run(operation: () => Promise<void>): Promise<void>;
  status(message: string, error?: boolean): void;
}) {
  let epoch = 0,
    host: HostCapabilities | undefined,
    binding: SmartAccountBinding | undefined;
  let creation:
    | {
        request: WalletCreationRequest;
        result: WalletCreationPreparation;
        manifest: SmartAccountManifest;
        transactionHash?: Hex;
      }
    | undefined;
  let challenge:
    | {
        request: BindingRequest;
        result: BindingChallenge;
        document: WalletTypedData;
        signatures: Hex[];
      }
    | undefined;
  let session: StoredSession | undefined,
    plan: SmartWalletPlan | undefined,
    operation: PreparedUserOperation | undefined;
  let operationClient: SmartAccountClient | undefined,
    operationSignatures: Hex[] = [],
    sessionSignature: Hex | undefined,
    submissionKey: string | undefined;
  let key: ReturnType<typeof privateKeyToAccount> | undefined;
  function connection() {
    return (
      options.connection() ?? fail("Connect and load your owner account first.")
    );
  }
  function ownerClient() {
    return new SmartAccountClient(connection().client);
  }
  function checkpoint() {
    const c = connection(),
      generation = epoch;
    return {
      c,
      check() {
        if (options.connection() !== c || epoch !== generation)
          fail("The wallet connection changed. Review again.");
      },
    };
  }
  function deployment() {
    const d = host?.smartAccounts.deployments.find(
      (x) => x.manifestId === field("smart-manifest").value,
    );
    if (!d) return fail("Select a hosted reviewed deployment.");
    if (d.chainId !== connection().chainId)
      fail(
        "Switch to the selected chain, then connect and load the account again.",
      );
    return d;
  }
  function manifest() {
    return (
      deployment().manifest ??
      fail(
        "This host must publish its reviewed deployment pins before wallet signing is available.",
      )
    );
  }
  function bound() {
    if (
      !binding ||
      binding.ownerAccountId !== connection().accountId ||
      binding.wallet.chainId !== connection().chainId
    )
      fail("Load or bind a smart wallet on the connected chain.");
    return binding;
  }
  function requireSession() {
    if (!session || session.compiled.bindingId !== bound().id)
      return fail("Prepare or load a session for this wallet first.");
    return session;
  }
  function executionClient() {
    if (field("operation-authority").value === "owner") return ownerClient();
    const s = requireSession();
    if (
      !key ||
      !same(key.address, s.compiled.sessionKey) ||
      s.state !== "active"
    )
      fail("Load the exact local bot key for an active session.");
    return new SmartAccountClient(
      new SignedRestClient({
        audience: options.audience,
        accountId: connection().accountId,
        signer: key!,
        grantId: s.compiled.grantId,
      }),
    );
  }
  function clearOperation() {
    operation = undefined;
    operationClient = undefined;
    operationSignatures = [];
    sessionSignature = undefined;
    submissionKey = undefined;
    for (const id of ["operation-sign", "operation-submit", "operation-status"])
      button(id).disabled = true;
    field("operation-owner-signatures").value = "";
    element("operation-review").hidden = true;
    element("operation-result").textContent = "";
  }
  function setPlan(next: SmartWalletPlan) {
    clearOperation();
    plan = next;
    show("operation-plan-review", next);
    field("operation-steps").value = next.draft.calls
      .map((_c, i) => i)
      .join(",");
    button("operation-prepare").disabled = !executionAvailable();
  }
  function executionAvailable() {
    const provider = host?.userOperations?.providers?.find(
      (entry) => entry.chainId === options.connection()?.chainId,
    );
    return (
      host?.userOperations?.preparation === true &&
      provider !== undefined &&
      (field("operation-authority").value !== "session" ||
        provider.paymasterConfigured)
    );
  }
  function refreshReadiness() {
    if (!host) return;
    element("smart-readiness").textContent = executionAvailable()
      ? "A provider is configured for the connected chain. Each wallet, session and gas policy still needs current verification."
      : "Hosted execution is unavailable for this connection. Wallet and policy reviews remain available; operation preparation needs a configured provider and session sponsorship.";
  }
  function setBinding(next: SmartAccountBinding) {
    if (
      next.ownerAccountId !== connection().accountId ||
      next.wallet.chainId !== connection().chainId
    )
      fail("The returned binding belongs to another account or chain.");
    epoch++;
    binding = next;
    session = undefined;
    plan = undefined;
    key = undefined;
    clearOperation();
    field("smart-binding-id").value = next.id;
    field("smart-address").value = next.wallet.address;
    show("smart-bindings", next);
    element<HTMLFieldSetElement>("session-fields").disabled = false;
    element<HTMLFieldSetElement>("operation-fields").disabled = false;
    button("session-activate").disabled = true;
    button("session-revoke").disabled = true;
    button("operation-prepare").disabled = true;
    field("session-id").value = "";
    element("session-review").hidden = true;
    element("session-quota").hidden = true;
    element("session-key-status").textContent = "No local key loaded.";
  }
  function setSession(next: StoredSession) {
    if (
      next.compiled.bindingId !== bound().id ||
      next.compiled.ownerAccountId !== connection().accountId
    )
      fail("The returned session belongs to another account or wallet.");
    if (
      session &&
      (session.id !== next.id ||
        session.compiled.compiledHash !== next.compiled.compiledHash ||
        (session.state === "active" && next.state !== "active"))
    ) {
      epoch++;
      plan = undefined;
      clearOperation();
      button("operation-prepare").disabled = true;
      element("operation-plan-review").hidden = true;
    }
    session = next;
    field("session-id").value = next.id;
    field("session-grant").value = next.compiled.grantId;
    show("session-review", next);
    button("session-activate").disabled = !["prepared", "installing"].includes(
      next.state,
    );
    button("session-revoke").disabled = next.state === "revoked";
    if (key && !same(key.address, next.compiled.sessionKey)) {
      key = undefined;
      element("session-key-status").textContent =
        "Local key cleared because this session uses a different key.";
    }
  }
  function event(id: string, action: () => Promise<void>) {
    button(id).addEventListener("click", () => void options.run(action));
  }
  event("smart-discover", async () => {
    const result = await readPublicRestJson<HostCapabilities>(
      options.audience,
      "/api/v1/capabilities",
    );
    if (!Array.isArray(result.smartAccounts?.deployments))
      fail("This host has not configured smart wallets.");
    host = result;
    refreshReadiness();
    if (plan && !operation)
      button("operation-prepare").disabled = !executionAvailable();
    const select = element<HTMLSelectElement>("smart-manifest");
    select.replaceChildren();
    for (const d of result.smartAccounts.deployments) {
      const option = document.createElement("option");
      option.value = d.manifestId;
      option.textContent = `Chain ${d.chainId} / ${d.manifestId}`;
      select.append(option);
    }
    show("smart-capabilities", {
      deployments: result.smartAccounts.deployments.map(
        ({ manifest: _m, ...d }) => d,
      ),
      requirements: result.smartAccounts.requirements,
      execution: result.userOperations ?? { state: "unavailable" },
    });
    options.status(
      result.userOperations?.relay
        ? "Hosted providers are configured. Each wallet and session still requires current onchain verification."
        : "Discovery loaded. Hosted execution is unavailable until this host configures its reviewed execution stack.",
    );
  });
  event("smart-switch", async () => {
    const c = connection(),
      d = host?.smartAccounts.deployments.find(
        (x) => x.manifestId === field("smart-manifest").value,
      );
    if (!d) fail("Select a hosted chain first.");
    await c.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHex(d!.chainId) }],
    });
    options.status(
      "Chain switch requested. Connect and load the account on that chain.",
    );
  });
  event("smart-create-prepare", async () => {
    const { c, check } = checkpoint(),
      m = manifest();
    const owners = field("smart-owners")
      .value.split(/[\s,]+/)
      .filter(Boolean)
      .map((x) => getAddress(x));
    const request = {
      manifestId: m.id,
      owners,
      threshold: Number(field("smart-threshold").value),
      saltNonce: BigInt(newRequestNonce()).toString(),
    };
    const result = (
      await new SmartAccountClient(c.client).prepareCreation(request)
    ).creation;
    check();
    verifyWalletCreation({ manifest: m, request, creation: result });
    creation = { request, result, manifest: m };
    show("smart-creation", result);
    button("smart-create-send").disabled = false;
    button("smart-create-status").disabled = true;
    options.status(
      "Review the wallet owners, threshold, factory and creation fee before sending the wallet transaction.",
    );
  });
  event("smart-create-send", async () => {
    const { c, check } = checkpoint(),
      reviewed = creation;
    if (!reviewed) fail("Prepare wallet creation first.");
    verifyWalletCreation({
      manifest: reviewed!.manifest,
      request: reviewed!.request,
      creation: reviewed!.result,
    });
    await assertWalletIdentity(
      c.provider,
      c.owner,
      reviewed!.result.chainId,
      () => options.connection() === c,
    );
    check();
    button("smart-create-send").disabled = true;
    const hash = await c.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: c.owner,
          to: reviewed!.result.transaction.to,
          value: "0x0",
          data: reviewed!.result.transaction.data,
        },
      ],
    });
    check();
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
      fail(
        "The wallet did not return a transaction hash. Check its activity before preparing another creation.",
      );
    reviewed!.transactionHash = hash as Hex;
    show("smart-creation", {
      ...reviewed!.result,
      transactionHash: hash,
      state: "pending",
    });
    button("smart-create-status").disabled = false;
    options.status(
      "Creation submitted. Check the receipt before binding the wallet.",
    );
  });
  event("smart-create-status", async () => {
    const { c, check } = checkpoint(),
      reviewed = creation;
    if (!reviewed?.transactionHash) fail("Submit wallet creation first.");
    await assertWalletIdentity(c.provider, c.owner, reviewed!.result.chainId);
    check();
    const receipt = (await c.provider.request({
      method: "eth_getTransactionReceipt",
      params: [reviewed!.transactionHash],
    })) as { status?: string; transactionHash?: string } | null;
    check();
    if (!receipt) {
      options.status("Creation is still pending. Check again later.");
      return;
    }
    if (
      receipt.status !== "0x1" ||
      !receipt.transactionHash ||
      !same(receipt.transactionHash, reviewed!.transactionHash!)
    )
      fail(
        "Creation did not return a successful matching receipt. Inspect the wallet transaction.",
      );
    field("smart-address").value = reviewed!.result.address;
    show("smart-creation", { ...reviewed!.result, receipt });
    options.status(
      "A successful creation receipt was found. Inspect and bind the wallet to verify its deployed code and authority.",
    );
  });
  event("smart-bind-prepare", async () => {
    const { c, check } = checkpoint(),
      d = deployment();
    const request = {
      manifestId: d.manifestId,
      address: address("smart-address"),
      nonce: newRequestNonce(),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
    const result = await ownerClient().challenge(request);
    check();
    const document = smartBindingDocument({
      audience: options.audience,
      accountId: c.accountId,
      owner: c.owner,
      request,
      challenge: result,
    });
    challenge = { request, result, document, signatures: [] };
    field("smart-binding-signatures").value = "";
    show("smart-binding-review", {
      state: result.state,
      digest: result.digest,
      typedData: document,
    });
    button("smart-bind-sign").disabled = false;
    button("smart-bind-submit").disabled = false;
    options.status(
      "Review current owners, threshold and deployed authority, then sign the exact binding document.",
    );
  });
  event("smart-bind-sign", async () => {
    const { c, check } = checkpoint(),
      reviewed = challenge;
    if (!reviewed) fail("Prepare the binding challenge first.");
    const signature = await signWalletTypedData({
      provider: c.provider,
      address: c.owner,
      chainId: c.chainId,
      document: reviewed!.document,
      stillCurrent: () => options.connection() === c,
    });
    check();
    reviewed!.signatures = [signature];
    button("smart-bind-sign").disabled = true;
    options.status(
      "Owner binding signature collected. Add any other threshold signatures, then bind.",
    );
  });
  event("smart-bind-submit", async () => {
    const { check } = checkpoint(),
      reviewed = challenge;
    if (!reviewed) fail("Prepare the binding challenge first.");
    const signature = await packOwnerSignatures({
      digest: reviewed!.result.digest,
      owners: reviewed!.result.state.owners,
      threshold: reviewed!.result.state.threshold,
      signatures: [
        ...reviewed!.signatures,
        ...signatureList("smart-binding-signatures"),
      ],
    });
    check();
    const result = await ownerClient().bind({
      ...reviewed!.request,
      stateHash: reviewed!.result.state.stateHash,
      signature,
    });
    check();
    setBinding(result);
    button("smart-bind-submit").disabled = true;
    options.status(
      "Smart wallet bound. Session authority still requires a separate owner activation.",
    );
  });
  event("smart-bind-list", async () => {
    const { check } = checkpoint(),
      result = await ownerClient().bindings();
    check();
    show("smart-bindings", result);
  });
  event("smart-bind-load", async () => {
    const { check } = checkpoint(),
      result = await ownerClient().binding(
        field("smart-binding-id").value as Hex,
      );
    check();
    setBinding(result);
    options.status("Current smart-wallet binding loaded.");
  });
  field("session-action").addEventListener("change", () => {
    element("session-payment").hidden =
      field("session-action").value === "v6-project-uri";
    element<HTMLInputElement>("session-budget-consent").checked = false;
  });
  event("session-prepare", async () => {
    const { check } = checkpoint(),
      b = bound(),
      kind = field("session-action").value;
    const policy: SessionPolicyInput = {
      bindingId: b.id,
      grantId: field("session-grant").value.trim(),
      generation: Date.now().toString(),
      nonce: newRequestNonce(),
      validAfter: Math.floor(Date.now() / 1000) + 300,
      durationDays: Number(field("session-days").value) as 7 | 30,
      maximumCalls: decimal("session-calls"),
      gasBudget: json("session-gas"),
      allocations: [],
      actions: [],
    };
    if (kind === "v6-project-uri")
      policy.actions = [
        {
          kind,
          controller: address("session-target"),
          projectId: decimal("session-project"),
        },
      ];
    else {
      if (!element<HTMLInputElement>("session-budget-consent").checked)
        fail(
          "Explicitly approve the exact isolated repeat-payment budget first.",
        );
      const total = decimal("session-total"),
        perCallLimit = decimal("session-per-call"),
        beneficiary = address("session-beneficiary");
      policy.allocations = [
        {
          id: "isolated",
          total,
          allocations: [
            {
              id: "local",
              chainId: b.wallet.chainId,
              asset: address("session-asset"),
              limit: total,
            },
          ],
        },
      ];
      if (kind === "erc20-transfer")
        policy.actions = [
          {
            kind,
            allocationId: "local",
            beneficiary,
            perCallLimit,
            totalLimit: total,
          },
        ];
      else if (kind === "v6-pay")
        policy.actions = [
          {
            kind,
            allocationId: "local",
            beneficiary,
            perCallLimit,
            totalLimit: total,
            terminal: address("session-target"),
            projectId: decimal("session-project"),
            minReturnedTokens: decimal("session-min-return"),
          },
        ];
      else fail("Select a supported exact action.");
    }
    const result = await ownerClient().prepareSession(policy);
    check();
    if (
      result.compiled.validAfter !== policy.validAfter ||
      result.compiled.validUntil !==
        policy.validAfter + policy.durationDays * 86400 ||
      result.compiled.grantId !== policy.grantId
    )
      fail(
        "The compiled session differs from the selected period or bot grant.",
      );
    setSession(result);
    show("session-review", { requestedPolicy: policy, session: result });
    options.status(
      "Policy prepared, starting in five minutes. Review every limit and the compiled hash before preparing owner activation.",
    );
  });
  for (const kind of ["activation", "revocation"] as const)
    event(
      kind === "activation" ? "session-activate" : "session-revoke",
      async () => {
        const { check } = checkpoint(),
          s = requireSession();
        const result = await ownerClient().sessionPlan(
          s.id,
          kind,
          s.compiled.compiledHash,
        );
        check();
        setSession(result.session);
        field("operation-authority").value = "owner";
        authorityChanged();
        setPlan(result.plan);
        options.status(
          `${kind === "activation" ? "Activation" : "Revocation"} plan prepared. Review and sign the owner operation below; the onchain change is not confirmed yet.`,
        );
        element("operation-plan-review").scrollIntoView({ block: "nearest" });
      },
    );
  event("session-refresh", async () => {
    const { check } = checkpoint(),
      id = field("session-id").value.trim(),
      client = ownerClient();
    const result = await client.session(id);
    check();
    const quota = await client.quota(id);
    check();
    setSession(result);
    show("session-quota", quota);
    options.status(
      `Session state: ${result.state}. Quota reflects the displayed onchain observation.`,
    );
  });
  function authorityChanged() {
    epoch++;
    refreshReadiness();
    const local = field("operation-authority").value === "session";
    element("session-key-fields").hidden = !local;
    element("operation-owner-signatures-label").hidden = local;
    plan = undefined;
    clearOperation();
    element("operation-plan-review").hidden = true;
    button("operation-prepare").disabled = true;
  }
  field("operation-authority").addEventListener("change", authorityChanged);
  field("session-key-file").addEventListener(
    "change",
    () =>
      void options.run(async () => {
        const { check } = checkpoint(),
          input = element<HTMLInputElement>("session-key-file"),
          file = input.files?.[0];
        input.value = "";
        key = undefined;
        if (!file || file.size > 4096)
          fail(
            "Choose the small JSON bot key file downloaded during registration.",
          );
        let value: unknown;
        try {
          value = JSON.parse(await file!.text());
        } catch {
          fail("The local key file is invalid.");
        }
        check();
        const data = value as {
          format?: string;
          botAddress?: string;
          privateKey?: string;
        };
        if (
          !data ||
          data.format !== "juicebox-center-bot-key-v1" ||
          typeof data.privateKey !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(data.privateKey)
        )
          fail("Use a Juicebox Center bot key file.");
        const signer = privateKeyToAccount(data.privateKey as Hex),
          s = requireSession();
        if (
          !data.botAddress ||
          !same(signer.address, data.botAddress) ||
          !same(signer.address, s.compiled.sessionKey)
        )
          fail("The local key does not match this session's registered bot.");
        epoch++;
        clearOperation();
        key = signer;
        element("session-key-status").textContent =
          `Local signer: ${signer.address}. Private key retained only in this page's memory.`;
        options.status(
          "Local session signer loaded. Prepare the action using session authority.",
        );
      }),
  );
  event("session-key-clear", async () => {
    epoch++;
    key = undefined;
    clearOperation();
    element("session-key-status").textContent = "Local key cleared.";
  });
  event("operation-template", async () => {
    const template = sessionActionPlanInput(requireSession(), {
      uri: field("operation-uri").value.trim(),
      amount: field("operation-amount").value.trim(),
      tokenContractId: field("operation-token-contract").value.trim(),
    });
    field("operation-name").value = "contract_calls";
    field("operation-input").value = JSON.stringify(template, null, 2);
    options.status(
      "Call input filled from the first reviewed session action. Review it, then prepare the plan.",
    );
  });
  event("operation-plan", async () => {
    const { check } = checkpoint(),
      client = executionClient(),
      result = await client.preparePlan(
        bound().id,
        field("operation-name").value.trim(),
        json("operation-input"),
      );
    check();
    setPlan(result);
    options.status(
      "Review the exact calls, values and warnings in the smart-wallet plan.",
    );
  });
  event("operation-prepare", async () => {
    if (!executionAvailable())
      fail(
        "Check hosted capabilities. A provider for this chain and session sponsorship must be configured before preparing an operation.",
      );
    const { check } = checkpoint(),
      reviewed = plan;
    if (!reviewed) fail("Prepare a plan first.");
    const indexes = field("operation-steps")
      .value.split(",")
      .map((x) => x.trim());
    if (
      !indexes.length ||
      indexes.some((x) => !/^(0|[1-9][0-9]{0,3})$/.test(x))
    )
      fail("Enter exact zero-based step indexes separated by commas.");
    const freshBinding = await ownerClient().binding(bound().id);
    check();
    if (
      freshBinding.ownerAccountId !== connection().accountId ||
      freshBinding.wallet.chainId !== connection().chainId
    )
      fail("The wallet binding changed.");
    binding = freshBinding;
    const client = executionClient(),
      result = await client.prepareUserOperation({
        planId: reviewed!.id,
        stepIndexes: indexes.map(Number),
        ...(field("operation-authority").value === "session"
          ? { sessionId: requireSession().id }
          : {}),
      });
    check();
    assertReviewedOperation(result, reviewed!);
    clearOperation();
    operation = result;
    operationClient = client;
    submissionKey = smartRequestKey();
    show("operation-review", result);
    button("operation-prepare").disabled = true;
    button("operation-sign").disabled = false;
    button("operation-status").disabled = false;
    options.status(
      "Operation prepared and simulated. Review calldata, gas, paymaster, expiration and the public signing document before signing.",
    );
  });
  event("operation-sign", async () => {
    const { c, check } = checkpoint(),
      reviewed = operation;
    if (!reviewed || !plan) fail("Prepare a fresh operation first.");
    assertReviewedOperation(reviewed!, plan!);
    if (reviewed!.session) {
      if (!key) fail("Load the local session key first.");
      sessionSignature = await signSessionUserOperation({
        record: reviewed!,
        session: requireSession(),
        signer: key!,
      });
      check();
    } else {
      const m = manifest();
      if (
        !m.entryPoint ||
        m.id !== bound().manifestId ||
        !same(m.revision, bound().state.manifestRevision)
      )
        fail("Choose the exact reviewed deployment for this wallet binding.");
      const payload = ownerOperationSigning({
        record: reviewed!,
        binding: bound(),
        operation: reviewed!.operation,
        chainId: m.chainId,
        safe7579: m.safe7579.address,
        entryPoint: m.entryPoint!.address,
        validAfter: String(Math.floor(reviewed!.createdAt / 1000)),
        validUntil: String(Math.floor(reviewed!.expiresAt / 1000)),
      });
      const signature = await signWalletTypedData({
        provider: c.provider,
        address: c.owner,
        chainId: c.chainId,
        document: payload.typedData,
        stillCurrent: () => options.connection() === c,
      });
      check();
      operationSignatures = [signature];
    }
    button("operation-sign").disabled = true;
    button("operation-submit").disabled = false;
    options.status(
      "Signature collected. Add any other owner threshold signatures, then explicitly submit.",
    );
  });
  event("operation-submit", async () => {
    const { check } = checkpoint(),
      reviewed = operation;
    if (!reviewed || !plan || !operationClient || !submissionKey)
      fail("Prepare and sign an operation first.");
    assertReviewedOperation(reviewed!, plan!);
    const signature = reviewed!.session
      ? sessionSignature
      : await ownerOperationSignature(
          reviewed!.signing as ReturnType<typeof ownerOperationSigning>,
          bound(),
          [
            ...operationSignatures,
            ...signatureList("operation-owner-signatures"),
          ],
        );
    check();
    if (!signature) fail("Sign the exact session operation first.");
    // Once a request is sent, its outcome can be unknown. Never generate a new submission key or auto-resubmit.
    button("operation-submit").disabled = true;
    button("operation-sign").disabled = true;
    element("operation-result").textContent =
      "Submission started. If the request fails, refresh this operation's status before taking another action.";
    const result = await operationClient!.submitUserOperation(
      reviewed!.id,
      signature!,
      submissionKey,
    );
    check();
    operation = result;
    show("operation-review", result);
    element("operation-result").textContent =
      `Operation ${result.id}: ${result.state}. A submission is not confirmation.`;
    options.status(
      "Operation submitted. Refresh its status to check canonical confirmation.",
    );
  });
  event("operation-status", async () => {
    const { check } = checkpoint(),
      reviewed = operation;
    if (!reviewed || !operationClient) fail("Prepare an operation first.");
    const result = await operationClient!.userOperation(reviewed!.id);
    check();
    operation = result;
    show("operation-review", result);
    element("operation-result").textContent =
      `Operation ${result.id}: ${result.state}.`;
    options.status(
      `Operation state: ${result.state}. Refresh the session to observe activation, revocation or counters.`,
    );
  });
  return {
    accountReady(ready: boolean) {
      refreshReadiness();
      element<HTMLFieldSetElement>("smart-fields").disabled = !ready;
      if (ready && !field("smart-owners").value)
        field("smart-owners").value = connection().owner;
    },
    reset() {
      epoch++;
      binding = undefined;
      creation = undefined;
      challenge = undefined;
      session = undefined;
      plan = undefined;
      key = undefined;
      clearOperation();
      for (const id of ["smart-fields", "session-fields", "operation-fields"])
        element<HTMLFieldSetElement>(id).disabled = true;
      for (const id of [
        "smart-create-send",
        "smart-create-status",
        "smart-bind-sign",
        "smart-bind-submit",
        "session-activate",
        "session-revoke",
        "operation-prepare",
      ])
        button(id).disabled = true;
      for (const id of [
        "smart-owners",
        "smart-address",
        "smart-binding-id",
        "smart-binding-signatures",
        "session-id",
        "session-grant",
        "session-key-file",
      ])
        field(id).value = "";
      for (const id of [
        "smart-creation",
        "smart-binding-review",
        "smart-bindings",
        "session-review",
        "session-quota",
        "operation-plan-review",
      ])
        element(id).hidden = true;
      element("session-key-status").textContent = "No local key loaded.";
    },
  };
}
