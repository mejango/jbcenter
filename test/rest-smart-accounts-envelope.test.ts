import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashMessage,
  keccak256,
  parseAbi,
  parseAbiParameters,
  recoverAddress,
  sliceHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertSafe7579Execution,
  decodeLegacyUseSignature,
  decodeSafe7579Execution,
  decodeSafe7579Nonce,
  encodeLegacyUseSignature,
  encodeSafe7579Execution,
  encodeSafe7579Nonce,
  encodeSafe7579OwnerNonce,
  encodeSafe7579OwnerSignature,
  legacySessionSigningPayload,
  safe7579OwnerSigningPayload,
  verifyLegacySessionSignature,
  verifySafe7579OwnerSignature,
  safe7579NonceKey,
  SAFE7579_BATCH_MODE,
  SAFE7579_SINGLE_MODE,
  type Safe7579Call,
} from "../src/rest/smartAccounts/accountExecution.js";
import {
  encodeOwnerSessionRevocation,
  encodeOwnerSessionSetup,
} from "../src/rest/smartAccounts/setup.js";
import type { CompiledSession } from "../src/rest/smartAccounts/compiler/types.js";
import { compiledSessionHash } from "../src/rest/smartAccounts/compiler.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import type { UserOperationV07 } from "../src/rest/userOperations/types.js";

const validator = "0x00000000002b0ecfbd0496ee71e01257da0e37de" as Address;
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const beneficiary = "0x3333333333333333333333333333333333333333" as Address;
const hash = `0x${"12".repeat(32)}` as Hex;
const otherHash = `0x${"34".repeat(32)}` as Hex;
const transferAbi = parseAbi(["function transfer(address to, uint256 amount)"]);
const calls: Safe7579Call[] = [
  {
    target: token,
    value: "0",
    callData: encodeFunctionData({
      abi: transferAbi,
      functionName: "transfer",
      args: [beneficiary, 42n],
    }),
  },
  {
    target: beneficiary,
    value: "12",
    callData: "0x",
  },
];

/** Independent decoding uses the reproduced compiler artifacts, not the encoder ABI exports. */
const accountAbi = JSON.parse(
  readFileSync(
    new URL(
      "../src/rest/smartAccounts/stack/artifacts/Safe7579.json",
      import.meta.url,
    ),
    "utf8",
  ),
).abi as Abi;
const sessionTuple =
  "(address,bytes,bytes32,(address,bytes)[],((bytes32,string[])[],(address,bytes)[]),(bytes4,address,(address,bytes)[])[],bool)";
const sessionAbi = JSON.parse(
  readFileSync(
    new URL(
      "../src/rest/smartAccounts/stack/artifacts/SmartSession.json",
      import.meta.url,
    ),
    "utf8",
  ),
).abi as Abi;

function fixture(): CompiledSession {
  const sessionKey = privateKeyToAccount(`0x${"aa".repeat(32)}`).address;
  const pin = {
    address: validator,
    runtimeCodeHash: hash,
    source: {
      repository: "https://github.com/erc7579/smartsessions",
      commit: "f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188",
      artifactSha256: "12".repeat(32),
    },
  };
  const session = {
    sessionValidator: "0x2483da3a338895199e5e538530213157e931bf06" as Address,
    sessionValidatorInitData: encodeAbiParameters(
      parseAbiParameters("uint256,address[]"),
      [1n, [sessionKey]],
    ),
    salt: hash,
    userOpPolicies: [{ policy: beneficiary, initData: "0x1234" as Hex }],
    erc7739Policies: {
      allowedERC7739Content: [] as [],
      erc1271Policies: [] as [],
    },
    actions: [
      {
        actionTargetSelector: "0xa9059cbb" as Hex,
        actionTarget: token,
        actionPolicies: [{ policy: beneficiary, initData: "0x1234" as Hex }],
      },
    ],
    permitERC4337Paymaster: false,
  };
  const compiled: CompiledSession = {
    schemaVersion: 1,
    stack: "legacy-f24dddf-safe7579-f22a194",
    ownerAccountId: "eip155:1:0x4444444444444444444444444444444444444444",
    bindingId: hash,
    grantId: "grant-1",
    sessionKey,
    chainId: 11155111,
    wallet,
    generation: "1",
    nonce: otherHash,
    validAfter: 1000,
    validUntil: 605800,
    salt: hash,
    policyHash: fingerprint({}),
    compiledHash: otherHash,
    permissionId: keccak256(
      encodeAbiParameters(parseAbiParameters("address,bytes,bytes32"), [
        session.sessionValidator,
        session.sessionValidatorInitData,
        session.salt,
      ]),
    ),
    manifestRevision: hash,
    activationEnableNonce: "7",
    reviewedPolicy: {},
    smartSessions: pin,
    sessionValidator: { ...pin, address: session.sessionValidator },
    session,
    configurations: [],
  };
  compiled.compiledHash = compiledSessionHash(compiled);
  return compiled;
}

describe("source-pinned Safe7579 nonce and legacy session envelope", () => {
  it("places validator, lane, and EntryPoint sequence in their exact independent bit ranges", () => {
    const nonce = encodeSafe7579Nonce({
      validator,
      lane: "16909060",
      sequence: "18446744073709551615",
    });
    expect(toHex(BigInt(nonce), { size: 32 })).toBe(
      `${validator}01020304ffffffffffffffff`,
    );
    expect(
      toHex(BigInt(safe7579NonceKey(validator, "16909060")), { size: 24 }),
    ).toBe(`${validator}01020304`);
    const decoded = decodeSafe7579Nonce(nonce);
    expect(decoded.validator.toLowerCase()).toBe(validator);
    expect(decoded.lane).toBe("16909060");
    expect(decoded.sequence).toBe("18446744073709551615");
    expect(decoded.key).toBe((BigInt(nonce) >> 64n).toString());
    expect(BigInt(nonce) >> 96n).toBe(BigInt(validator));
  });

  it("rejects fallback-owner nonces and integer truncation or ambiguous decimal encodings", () => {
    expect(() => decodeSafe7579Nonce("1")).toThrow(/nonzero validator/);
    for (const lane of ["4294967296", "-1", "01"])
      expect(() =>
        encodeSafe7579Nonce({ validator, lane, sequence: "0" }),
      ).toThrow();
    expect(() =>
      encodeSafe7579Nonce({
        validator,
        lane: "0",
        sequence: "18446744073709551616",
      }),
    ).toThrow();
    expect(() => decodeSafe7579Nonce((1n << 256n).toString())).toThrow();
  });

  it("packs only USE, permissionId, and the opaque session-validator signature", () => {
    const signature = `0x${"56".repeat(64)}1b` as Hex;
    const envelope = encodeLegacyUseSignature(hash, signature);
    expect(envelope).toBe(`0x00${hash.slice(2)}${signature.slice(2)}`);
    expect(decodeLegacyUseSignature(envelope)).toEqual({
      permissionId: hash,
      signature,
    });
    for (const mode of ["01", "02", "ff"])
      expect(() =>
        decodeLegacyUseSignature(`0x${mode}${envelope.slice(4)}`),
      ).toThrow(/USE/);
    expect(() => decodeLegacyUseSignature(`0x00${hash.slice(2)}`)).toThrow();
    expect(() =>
      encodeLegacyUseSignature(`0x${"00".repeat(32)}`, signature),
    ).toThrow(/nonzero/);
  });

  it("uses the legacy OwnableValidator EIP-191 hash and rejects replay over changed nonce or chain", async () => {
    const signer = privateKeyToAccount(`0x${"aa".repeat(32)}`);
    // Model the v0.7 outer hash domain directly; the packed UserOp hash is opaque here.
    const operationHash = (chainId: bigint, sequence: string) =>
      keccak256(
        encodeAbiParameters(parseAbiParameters("bytes32,address,uint256"), [
          keccak256(
            encodeAbiParameters(parseAbiParameters("address,uint256,bytes32"), [
              wallet,
              BigInt(encodeSafe7579Nonce({ validator, lane: "0", sequence })),
              keccak256(encodeSafe7579Execution([calls[0]!])),
            ]),
          ),
          validator,
          chainId,
        ]),
      );
    const userOpHash = operationHash(11155111n, "4");
    const signature = await signer.signMessage({
      message: { raw: userOpHash },
    });
    const envelope = encodeLegacyUseSignature(hash, signature);
    const inner = decodeLegacyUseSignature(envelope).signature;
    expect(
      await recoverAddress({
        hash: hashMessage({ raw: userOpHash }),
        signature: inner,
      }),
    ).toBe(signer.address);
    expect(
      await recoverAddress({ hash: userOpHash, signature: inner }),
    ).not.toBe(signer.address);
    for (const changed of [
      operationHash(1n, "4"),
      operationHash(11155111n, "5"),
    ])
      expect(
        await recoverAddress({
          hash: hashMessage({ raw: changed }),
          signature: inner,
        }),
      ).not.toBe(signer.address);
    // PermissionId is inside signature, excluded from userOpHash. Rewrapping is possible when
    // another enabled permission accepts the same key; the transport must not claim otherwise.
    expect(
      decodeLegacyUseSignature(encodeLegacyUseSignature(otherHash, inner))
        .signature,
    ).toBe(inner);
  });
});

describe("canonical account execution admission", () => {
  it("independently decodes packed single execution without an ABI tuple wrapper", () => {
    const encoded = encodeSafe7579Execution([calls[0]!]);
    const [mode, body] = decodeAbiParameters(
      parseAbiParameters("bytes32,bytes"),
      sliceHex(encoded, 4),
    );
    expect(sliceHex(encoded, 0, 4)).toBe("0xe9ae5c53");
    expect(mode).toBe(SAFE7579_SINGLE_MODE);
    expect(sliceHex(body, 0, 20)).toBe(token);
    expect(BigInt(sliceHex(body, 20, 52))).toBe(0n);
    expect(sliceHex(body, 52)).toBe(calls[0]!.callData);
    expect(assertSafe7579Execution(encoded, [calls[0]!])).toEqual([calls[0]]);
  });

  it("independently decodes batches and preserves exact order, amounts, and bytes", () => {
    const encoded = encodeSafe7579Execution(calls);
    const outer = decodeFunctionData({ abi: accountAbi, data: encoded });
    expect(outer.functionName).toBe("execute");
    const [mode, body] = outer.args as readonly [Hex, Hex];
    expect(mode).toBe(SAFE7579_BATCH_MODE);
    const [batch] = decodeAbiParameters(
      parseAbiParameters("(address,uint256,bytes)[]"),
      body,
    );
    expect(batch).toEqual(
      calls.map((call) => [call.target, BigInt(call.value), call.callData]),
    );
    expect(assertSafe7579Execution(encoded, calls)).toEqual(calls);
    for (const changed of [
      [...calls].reverse(),
      [calls[0]!, { ...calls[1]!, value: "13" }],
      [{ ...calls[0]!, target: beneficiary }, calls[1]!],
      [{ ...calls[0]!, callData: `${calls[0]!.callData}00` as Hex }, calls[1]!],
      [calls[0]!],
    ])
      expect(() => assertSafe7579Execution(encoded, changed)).toThrow(
        /differs/,
      );
  });

  it("rejects delegate, try, nonzero mode payloads, alternate selectors, and malformed encodings", () => {
    const single = encodeSafe7579Execution([calls[0]!]);
    const [, body] = decodeAbiParameters(
      parseAbiParameters("bytes32,bytes"),
      sliceHex(single, 4),
    );
    for (const mode of [
      `0xff${"00".repeat(31)}`,
      `0x0001${"00".repeat(30)}`,
      `0x${"00".repeat(31)}01`,
    ] as Hex[])
      expect(() =>
        decodeSafe7579Execution(
          encodeFunctionData({
            abi: accountAbi,
            functionName: "execute",
            args: [mode, body],
          }),
        ),
      ).toThrow(/Only default/);
    expect(() =>
      decodeSafe7579Execution(`0xdeadbeef${single.slice(10)}`),
    ).toThrow();
    expect(() => decodeSafe7579Execution(`${single}00`)).toThrow(/canonical/);
    // ABI permits a relocated dynamic tail; exact admission rejects this alias.
    const relocated = concatHex([
      sliceHex(single, 0, 36),
      toHex(96n, { size: 32 }),
      toHex(0n, { size: 32 }),
      sliceHex(single, 68),
    ]);
    expect(() => decodeSafe7579Execution(relocated)).toThrow(/canonical/);
    expect(() => encodeSafe7579Execution([])).toThrow();
    expect(() => encodeSafe7579Execution(Array(17).fill(calls[0]))).toThrow();
  });
});

describe("owner session setup and durable revocation payloads", () => {
  it("installs only validator type 1 with explicit owner-approved mode 2 and exact Session[]", () => {
    const compiled = fixture();
    const setup = encodeOwnerSessionSetup({
      compiled,
      moduleInstalled: false,
      enabledPermissionIds: [],
    });
    expect(setup.activationEnableNonce).toBe("7");
    expect(setup.transaction).toMatchObject({
      to: wallet,
      value: "0",
      operation: 0,
    });
    const [call] = decodeSafe7579Execution(setup.transaction.data);
    expect(call!.target).toBe(wallet);
    const installed = decodeFunctionData({
      abi: accountAbi,
      data: call!.callData,
    });
    expect(installed.functionName).toBe("installModule");
    const [moduleType, module, initData] = installed.args as readonly [
      bigint,
      Address,
      Hex,
    ];
    expect(moduleType).toBe(1n);
    expect(module.toLowerCase()).toBe(validator);
    expect(sliceHex(initData, 0, 1)).toBe("0x02");
    const [sessions] = decodeAbiParameters(
      parseAbiParameters(`${sessionTuple}[]`),
      sliceHex(initData, 1),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]![0].toLowerCase()).toBe(
      compiled.session.sessionValidator,
    );
    expect(sessions[0]![2]).toBe(compiled.salt);
    expect(sessions[0]![4]).toEqual([[], []]);
    expect(sessions[0]![5][0]![0]).toBe("0xa9059cbb");
    expect(sessions[0]![6]).toBe(false);
  });

  it("initializes only an independently proved empty existing module with owner-approved mode 2", () => {
    const compiled = fixture();
    const setup = encodeOwnerSessionSetup({
      compiled,
      moduleInstalled: true,
      enabledPermissionIds: [],
    });
    const [call] = decodeSafe7579Execution(setup.transaction.data);
    expect(call!.target.toLowerCase()).toBe(validator);
    const decoded = decodeFunctionData({
      abi: sessionAbi,
      data: call!.callData,
    });
    expect(decoded.functionName).toBe("onInstall");
    expect(sliceHex(decoded.args![0] as Hex, 0, 1)).toBe("0x02");
    expect(() =>
      encodeOwnerSessionSetup({
        compiled,
        moduleInstalled: true,
        enabledPermissionIds: [hash],
      }),
    ).toThrow(/zero enabled/);
    expect(setup.calls).toHaveLength(1);
    expect(setup.requiredAuthority).toBe("safe-current-owner-threshold");
  });

  it("atomically removes the session and invalidates owner enable signatures, requiring nonce advancement", () => {
    const compiled = fixture();
    const revoke = encodeOwnerSessionRevocation({
      compiled,
      currentEnableNonce: "9",
    });
    expect(revoke.requiredPostState).toEqual({
      enabled: false,
      minimumEnableNonce: "10",
    });
    const decoded = decodeSafe7579Execution(revoke.transaction.data);
    expect(
      decoded.map((call) =>
        decodeFunctionData({ abi: sessionAbi, data: call.callData }),
      ),
    ).toEqual([
      { functionName: "removeSession", args: [compiled.permissionId] },
      { functionName: "revokeEnableSignature", args: [compiled.permissionId] },
    ]);
    expect(
      decoded.every(
        (call) => call.target.toLowerCase() === validator && call.value === "0",
      ),
    ).toBe(true);
    const [mode] = decodeAbiParameters(
      parseAbiParameters("bytes32,bytes"),
      sliceHex(revoke.transaction.data, 4),
    );
    expect(mode).toBe(SAFE7579_BATCH_MODE);
    expect(() =>
      encodeOwnerSessionRevocation({ compiled, currentEnableNonce: "6" }),
    ).toThrow(/predates/);
    expect(() =>
      encodeOwnerSessionRevocation({
        compiled,
        currentEnableNonce: ((1n << 256n) - 1n).toString(),
      }),
    ).toThrow(/advanced/);
  });

  it("rejects altered session identity, wildcard actions, and ERC1271 authorization", () => {
    const compiled = fixture();
    for (const changed of [
      { ...compiled, permissionId: otherHash },
      { ...compiled, session: { ...compiled.session, salt: otherHash } },
      {
        ...compiled,
        session: {
          ...compiled.session,
          actions: [{ ...compiled.session.actions[0]!, actionTarget: wallet }],
        },
      },
      {
        ...compiled,
        session: {
          ...compiled.session,
          actions: [
            {
              ...compiled.session.actions[0]!,
              actionTarget:
                "0x0000000000000000000000000000000000000001" as Address,
            },
          ],
        },
      },
    ])
      expect(() =>
        encodeOwnerSessionSetup({
          compiled: changed,
          moduleInstalled: true,
          enabledPermissionIds: [],
        }),
      ).toThrow();
    const signing = structuredClone(compiled);
    (signing.session.erc7739Policies.erc1271Policies as unknown[]).push({
      policy: token,
      initData: "0x",
    });
    signing.compiledHash = compiledSessionHash(signing);
    expect(() =>
      encodeOwnerSessionSetup({
        compiled: signing,
        moduleInstalled: true,
        enabledPermissionIds: [],
      }),
    ).toThrow(/arbitrary signing/);
  });
});

const adapter = "0x7579f2ad53b01c3d8779fe17928e0d48885b0003" as Address;
const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as Address;
function operationFixture(nonce = "0x4" as Hex): UserOperationV07 {
  return {
    sender: wallet,
    nonce,
    factory: beneficiary,
    factoryData: "0x12345678",
    callData: encodeSafe7579Execution([calls[0]!]),
    callGasLimit: "0x123",
    verificationGasLimit: "0x234",
    preVerificationGas: "0x345",
    maxFeePerGas: "0x567",
    maxPriorityFeePerGas: "0x456",
    paymaster: token,
    paymasterVerificationGasLimit: "0x678",
    paymasterPostOpGasLimit: "0x789",
    paymasterData: "0x1234abcd",
    signature: "0x",
  };
}

describe("exact owner and legacy session signing schemes", () => {
  it("matches independently assembled f22a194 SafeOp type/domain hashes over every operation field", () => {
    const operation = operationFixture();
    const payload = safe7579OwnerSigningPayload({
      operation,
      chainId: 11155111,
      safe7579: adapter,
      entryPoint,
      validAfter: "1234",
      validUntil: "5678",
    });
    const domainHash = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32,uint256,address"), [
        "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218",
        11155111n,
        adapter,
      ]),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "bytes32,address,uint256,bytes32,bytes32,uint128,uint128,uint256,uint128,uint128,bytes32,uint48,uint48,address",
        ),
        [
          "0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f",
          wallet,
          4n,
          keccak256(concatHex([beneficiary, "0x12345678"])),
          keccak256(operation.callData),
          0x234n,
          0x123n,
          0x345n,
          0x456n,
          0x567n,
          keccak256(
            concatHex([
              token,
              toHex(0x678n, { size: 16 }),
              toHex(0x789n, { size: 16 }),
              "0x1234abcd",
            ]),
          ),
          1234,
          5678,
          entryPoint,
        ],
      ),
    );
    expect(payload.digest).toBe(
      keccak256(concatHex(["0x1901", domainHash, structHash])),
    );
    expect(payload.typedData.domain.verifyingContract.toLowerCase()).toBe(
      adapter,
    );
    expect(payload.typedData.message.safe).toBe(wallet);
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(encodeSafe7579OwnerNonce("4", "1")).toBe(
      ((1n << 64n) | 4n).toString(),
    );
    expect(() =>
      safe7579OwnerSigningPayload({
        operation: {
          ...operation,
          nonce: toHex(
            BigInt(
              encodeSafe7579Nonce({ validator, lane: "0", sequence: "4" }),
            ),
          ),
        },
        chainId: 11155111,
        safe7579: adapter,
        entryPoint,
        validAfter: "1234",
        validUntil: "5678",
      }),
    ).toThrow(/zero-validator/);
  });

  it("verifies a full sorted EOA owner threshold and rejects replay and alternate signature forms", async () => {
    const owners = [
      privateKeyToAccount(`0x${"aa".repeat(32)}`),
      privateKeyToAccount(`0x${"bb".repeat(32)}`),
    ].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const base = {
      operation: operationFixture(),
      chainId: 11155111,
      safe7579: adapter,
      entryPoint,
      validAfter: "1234",
      validUntil: "5678",
    };
    const digest = safe7579OwnerSigningPayload(base).digest;
    const signatures = await Promise.all(
      owners.map((owner) => owner.sign({ hash: digest })),
    );
    const signature = encodeSafe7579OwnerSignature({
      ...base,
      signatures: concatHex(signatures),
    });
    expect(sliceHex(signature, 0, 12)).toBe("0x0000000004d200000000162e");
    const signed = {
      ...base,
      operation: { ...base.operation, signature },
      owners: owners.map((o) => o.address),
      threshold: 2,
    };
    expect(await verifySafe7579OwnerSignature(signed)).toEqual(
      owners.map((o) => o.address),
    );
    for (const changed of [
      { ...signed, chainId: 1 },
      { ...signed, safe7579: wallet },
      { ...signed, operation: { ...signed.operation, sender: beneficiary } },
      { ...signed, operation: { ...signed.operation, nonce: "0x5" as Hex } },
      {
        ...signed,
        operation: { ...signed.operation, factoryData: "0x12345679" as Hex },
      },
      {
        ...signed,
        operation: { ...signed.operation, callGasLimit: "0x124" as Hex },
      },
      {
        ...signed,
        operation: { ...signed.operation, paymasterData: "0x1234abce" as Hex },
      },
      { ...signed, validUntil: "5679" },
    ])
      await expect(verifySafe7579OwnerSignature(changed)).rejects.toThrow();
    const reversed = encodeSafe7579OwnerSignature({
      ...base,
      signatures: concatHex([...signatures].reverse()),
    });
    await expect(
      verifySafe7579OwnerSignature({
        ...signed,
        operation: { ...signed.operation, signature: reversed },
      }),
    ).rejects.toThrow(/sorted/);
    const duplicate = encodeSafe7579OwnerSignature({
      ...base,
      signatures: concatHex([signatures[0]!, signatures[0]!]),
    });
    await expect(
      verifySafe7579OwnerSignature({
        ...signed,
        operation: { ...signed.operation, signature: duplicate },
      }),
    ).rejects.toThrow(/sorted/);
    expect(() =>
      encodeSafe7579OwnerSignature({
        ...base,
        signatures: `${signatures[0]!.slice(0, -2)}01` as Hex,
      }),
    ).toThrow(/ECDSA/);
    await expect(
      verifySafe7579OwnerSignature({ ...signed, threshold: 1 }),
    ).rejects.toThrow(/count/);
  });

  it("requests EIP-191 signing for the checked legacy OwnableValidator and verifies its exact USE envelope", async () => {
    const signer = privateKeyToAccount(`0x${"aa".repeat(32)}`);
    const input = {
      operation: operationFixture(
        toHex(
          BigInt(encodeSafe7579Nonce({ validator, lane: "0", sequence: "4" })),
        ),
      ),
      chainId: 11155111,
      entryPoint,
      smartSessions: validator,
      permissionId: hash,
      sessionKey: signer.address,
    };
    const payload = legacySessionSigningPayload(input);
    const signature = await signer.signMessage({ message: payload.message });
    const signed = {
      ...input,
      operation: {
        ...input.operation,
        signature: encodeLegacyUseSignature(hash, signature),
      },
    };
    expect(await verifyLegacySessionSignature(signed)).toBe(signer.address);
    const raw = await signer.sign({ hash: payload.operationHash });
    await expect(
      verifyLegacySessionSignature({
        ...signed,
        operation: {
          ...signed.operation,
          signature: encodeLegacyUseSignature(hash, raw),
        },
      }),
    ).rejects.toThrow(/compiled session key/);
    await expect(
      verifyLegacySessionSignature({ ...signed, permissionId: otherHash }),
    ).rejects.toThrow(/different compiled permission/);
    await expect(
      verifyLegacySessionSignature({ ...signed, chainId: 1 }),
    ).rejects.toThrow(/compiled session key/);
    expect(() =>
      legacySessionSigningPayload({ ...input, smartSessions: wallet }),
    ).toThrow(/exact installed/);
  });
});
