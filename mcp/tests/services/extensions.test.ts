import { describe, expect, it, vi } from 'vitest';
import { NATIVE_TOKEN, jbPermissionsAbi, revLoansAbi } from '@bananapus/nana-sdk-core';
import {
  jbSuckerV6Abi,
  suckerBranchRoot,
  suckerLeafHash,
  suckerLeafProof,
  v6Address,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  pad,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  ExtensionService,
  prepareBridgeClaimInputSchema,
  quoteLoanInputSchema,
} from '../../src/services/extensions.js';
import type { BlockEvidence, RpcProvider } from '../../src/domain/types.js';

const project = { chainId: 8453, projectId: '12', version: 6 } as const;
const holder = '0x1111111111111111111111111111111111111111' as const;
const beneficiary = '0x2222222222222222222222222222222222222222' as const;
const token = '0x3333333333333333333333333333333333333333' as const;
const owner = '0x4444444444444444444444444444444444444444' as const;
const sucker = '0x5555555555555555555555555555555555555555' as const;
const feeless = '0x6666666666666666666666666666666666666666' as const;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const loans = v6Address('REVLoans', project.chainId);
const controller = v6Address('JBController', project.chainId);
const terminal = v6Address('JBMultiTerminal', project.chainId);
const permissions = v6Address('JBPermissions', project.chainId);
const duration = 315_360_000n;
const evidence: BlockEvidence = {
  source: 'rpc',
  chainId: 8453,
  blockNumber: '1234',
  blockHash: hash,
  timestamp: '1000',
};
const borrow = {
  project,
  holder,
  beneficiary,
  token: NATIVE_TOKEN,
  collateralCount: '1000',
  prepaidFeePercent: 25,
};
const repay = {
  chainId: 8453,
  loanId: '12000000000000000001',
  account: holder,
  beneficiary,
  maxRepayBorrowAmount: '10200',
  collateralCountToReturn: '1000',
} as const;
const leaf = {
  index: 0n,
  beneficiary: pad(holder, { size: 32 }),
  projectTokenCount: 1000n,
  terminalTokenAmount: 99n,
  metadata: zeroHash,
};
const proof = suckerLeafProof([suckerLeafHash(leaf)], 0);
const proofRoot = suckerBranchRoot(suckerLeafHash(leaf), proof, 0);
const bridge = prepareBridgeClaimInputSchema.parse({
  project,
  account: holder,
  sucker,
  claim: {
    token,
    leaf: { ...leaf, index: '0', projectTokenCount: '1000', terminalTokenAmount: '99' },
    proof: [...proof],
  },
});
type Request = {
  address?: Address;
  functionName: string;
  args?: readonly unknown[];
  account?: Address;
  blockNumber?: bigint;
  value?: bigint;
  gas?: bigint;
};
type FixtureOptions = {
  configurationHash?: Hex;
  projectOwner?: Address;
  controller?: Address;
  loanTerminal?: Address;
  contextToken?: Address;
  available?: bigint;
  capacity?: bigint;
  sourceTokenSurplus?: bigint;
  holderBalance?: bigint;
  ownerFeeless?: boolean;
  loansFeeless?: boolean;
  revTerminal?: Address;
  burnPermission?: boolean;
  packedPermissions?: bigint;
  delegatedPermission?: boolean;
  sourceToken?: Address;
  loanOwner?: Address;
  loanAmount?: bigint;
  loanCollateral?: bigint;
  sourceFee?: bigint;
  timestamp?: string;
  allowance?: bigint;
  delay?: bigint;
  registered?: boolean;
  suckerProjectId?: bigint;
  executedHash?: Hex;
  inboxRoot?: Hex;
  transport?: 'ccip' | 'native' | 'unknown';
  transportMinimum?: bigint;
  simulationFailure?: boolean;
  errorOn?: string;
};

function fixture(options: FixtureOptions = {}) {
  const loan = {
    amount: options.loanAmount ?? 10_000n,
    collateral: options.loanCollateral ?? 1000n,
    createdAt: 100,
    prepaidFeePercent: 25,
    prepaidDuration: 15_768_000,
    sourceToken: options.sourceToken ?? NATIVE_TOKEN,
  };
  const readContract = vi.fn(async (request: Request): Promise<unknown> => {
    if (request.functionName === options.errorOn) throw new Error('RPC unavailable');
    switch (request.functionName) {
      case 'hashedEncodedConfigurationOf':
        return options.configurationHash ?? hash;
      case 'OWNER':
        return owner;
      case 'LOANS':
        return loans;
      case 'MULTI_TERMINAL':
        return terminal;
      case 'TERMINAL':
        return options.loanTerminal ?? terminal;
      case 'PERMISSIONS':
        return permissions;
      case 'CONTROLLER':
        return controller;
      case 'DIRECTORY':
        return v6Address('JBDirectory', project.chainId);
      case 'PROJECTS':
        return v6Address('JBProjects', project.chainId);
      case 'ownerOf':
        return request.address?.toLowerCase() === loans.toLowerCase()
          ? (options.loanOwner ?? holder)
          : (options.projectOwner ?? owner);
      case 'currentRulesetOf':
        return [{ id: 1, metadata: BigInt(owner) << 82n }, {}];
      case 'controllerOf':
        return options.controller ?? controller;
      case 'accountingContextForTokenOf':
        return { token: options.contextToken ?? request.args?.[1], decimals: 18, currency: 61166 };
      case 'REV_ID':
        return 2n;
      case 'MIN_PREPAID_FEE_PERCENT':
        return 25n;
      case 'MAX_PREPAID_FEE_PERCENT':
        return 500n;
      case 'REV_PREPAID_FEE_PERCENT':
        return 10n;
      case 'LOAN_LIQUIDATION_DURATION':
        return duration;
      case 'FEELESS_ADDRESSES':
        return feeless;
      case 'hasPermission':
        return request.args?.[3] === 11n
          ? (options.burnPermission ?? true)
          : (options.delegatedPermission ?? false);
      case 'permissionsOf':
        return options.packedPermissions ?? 0n;
      case 'TOKENS':
        return v6Address('JBTokens', project.chainId);
      case 'borrowableAmountFrom':
        return [options.available ?? 10_000n, options.capacity ?? 50_000n];
      case 'currentSurplusOf':
        return options.sourceTokenSurplus ?? options.available ?? 10_000n;
      case 'isFeelessFor':
        return request.args?.[0] === owner
          ? (options.ownerFeeless ?? false)
          : (options.loansFeeless ?? false);
      case 'primaryTerminalOf':
        return options.revTerminal ?? terminal;
      case 'totalBalanceOf':
        return options.holderBalance ?? 1000n;
      case 'loanOf':
        return loan;
      case 'revnetIdOfLoanWith':
        return 12n;
      case 'determineSourceFeeAmount':
        return options.sourceFee ?? 100n;
      case 'cashOutDelayOf':
        return options.delay ?? 0n;
      case 'allowance':
        return options.allowance ?? 0n;
      case 'isSuckerOf':
        return options.registered ?? true;
      case 'projectId':
        return options.suckerProjectId ?? 12n;
      case 'executedLeafHashOf':
        return options.executedHash ?? zeroHash;
      case 'inboxOf':
        return { nonce: 1n, root: options.inboxRoot ?? proofRoot };
      case 'CCIP_ROUTER':
        if (options.transport === 'ccip') return owner;
        throw new Error('Selector unavailable');
      case 'OPMESSENGER':
        if (options.transport === 'native') return owner;
        throw new Error('Selector unavailable');
      case 'ARBINBOX':
        throw new Error('Selector unavailable');
      default:
        throw new Error(`Unexpected contract read ${request.functionName}`);
    }
  });
  const simulateContract = vi.fn(async (request: Request) => {
    if (options.simulationFailure || (request.value ?? 0n) < (options.transportMinimum ?? 0n))
      throw new Error('Exact simulation reverted');
    return { request, result: undefined };
  });
  const client = { readContract, simulateContract } as unknown as PublicClient;
  const snapshot = vi.fn(async () => ({
    client,
    evidence: { ...evidence, timestamp: options.timestamp ?? evidence.timestamp },
  }));
  const rpc: RpcProvider = { snapshot, client: () => client };
  return { service: new ExtensionService(rpc), readContract, simulateContract, snapshot };
}

describe('REVLoans quote provenance and exact fees', () => {
  it('keeps available debt, economic capacity, and fee-contingent liquid proceeds distinct', async () => {
    const { service, readContract, snapshot } = fixture();
    const quote = await service.quoteLoan(borrow);
    expect(quote).toMatchObject({
      availableGrossDebt: '10000',
      grossEconomicCapacity: '50000',
      protocolFee: '250',
      prepaidSourceFee: '250',
      revFeeIfPaymentSucceeds: '100',
      liquidProceeds: { minimumAtQuotedDebt: '9400', maximumIfFeePaymentsFail: '9750' },
      nftRecipient: holder,
      prepaidDurationSeconds: '15768000',
      evidence: [evidence],
    });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(readContract.mock.calls.every(([request]) => request.blockNumber === 1234n)).toBe(true);
    expect(
      readContract.mock.calls
        .filter(([request]) => request.functionName === 'isFeelessFor')
        .map(([request]) => request.args),
    ).toEqual([
      [owner, 12n, loans],
      [loans, 12n, loans],
    ]);
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'currentSurplusOf')?.[0],
    ).toMatchObject({
      address: terminal,
      args: [12n, [getAddress(NATIVE_TOKEN)], 18n, 61166n],
      blockNumber: 1234n,
    });
  });

  it('rejects multiasset backing that cannot fund the selected token without silently capping debt', async () => {
    // Aggregate surplus may be entirely in USDC while the requested ETH source is empty.
    const multiasset = fixture({
      available: 10_000n,
      capacity: 50_000n,
      sourceTokenSurplus: 0n,
      burnPermission: false,
    });
    const failure = {
      code: 'INSUFFICIENT_LOAN_SOURCE_SURPLUS',
      details: {
        token: getAddress(NATIVE_TOKEN),
        quotedAggregateGrossDebt: '10000',
        grossEconomicCapacity: '50000',
        sourceTokenSurplus: '0',
        evidence: [evidence],
      },
    };
    await expect(multiasset.service.quoteLoan(borrow)).rejects.toMatchObject(failure);
    await expect(
      multiasset.service.prepareBorrow({ ...borrow, account: holder }),
    ).rejects.toMatchObject(failure);
    expect(multiasset.simulateContract).not.toHaveBeenCalled();
    await expect(
      fixture({ sourceTokenSurplus: 9999n }).service.prepareBorrow({ ...borrow, account: holder }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_LOAN_SOURCE_SURPLUS',
      details: { quotedAggregateGrossDebt: '10000', sourceTokenSurplus: '9999' },
    });
    expect(await fixture({ sourceTokenSurplus: 10000n }).service.quoteLoan(borrow)).toMatchObject({
      availableGrossDebt: '10000',
      sourceTokenSurplus: '10000',
    });
    await expect(
      fixture({ errorOn: 'currentSurplusOf' }).service.quoteLoan(borrow),
    ).rejects.toThrow('RPC unavailable');
  });

  it('uses both terminal fee exemptions and a missing REV terminal without assuming fees', async () => {
    for (const options of [{ ownerFeeless: true }, { loansFeeless: true }]) {
      expect(await fixture(options).service.quoteLoan(borrow)).toMatchObject({
        protocolFee: '0',
        liquidProceeds: { minimumAtQuotedDebt: '9650', maximumIfFeePaymentsFail: '10000' },
      });
    }
    expect(await fixture({ revTerminal: zeroAddress }).service.quoteLoan(borrow)).toMatchObject({
      revFeeIfPaymentSucceeds: '0',
      liquidProceeds: { minimumAtQuotedDebt: '9500' },
    });
    const dust = await fixture({ available: 39n }).service.quoteLoan(borrow);
    expect(dust).toMatchObject({
      protocolFee: '0',
      prepaidSourceFee: '0',
      revFeeIfPaymentSucceeds: '0',
    });
  });

  it('rejects ordinary projects, changed configuration, unsupported sources, and failed reads', async () => {
    await expect(
      fixture({ configurationHash: zeroHash }).service.quoteLoan(borrow),
    ).rejects.toMatchObject({ code: 'NOT_A_REVNET' });
    for (const options of [
      { projectOwner: holder },
      { controller: holder },
      { loanTerminal: holder },
    ]) {
      await expect(fixture(options).service.quoteLoan(borrow)).rejects.toMatchObject({
        code: 'UNSUPPORTED_REVNET_CONFIGURATION',
      });
    }
    await expect(
      fixture({ contextToken: zeroAddress }).service.quoteLoan(borrow),
    ).rejects.toMatchObject({ code: 'INVALID_LOAN_SOURCE' });
    await expect(fixture({ errorOn: 'isFeelessFor' }).service.quoteLoan(borrow)).rejects.toThrow(
      'RPC unavailable',
    );
    await expect(
      fixture({ errorOn: 'borrowableAmountFrom' }).service.quoteLoan(borrow),
    ).rejects.toThrow('RPC unavailable');
  });

  it('uses exact integer arithmetic at uint112 scale and rejects collateral overflow', async () => {
    const gross = (1n << 111n) + 317n;
    const quote = await fixture({ available: gross }).service.quoteLoan({
      ...borrow,
      prepaidFeePercent: 500,
    });
    expect(quote.prepaidSourceFee).toBe((gross / 2n).toString());
    expect(quote.protocolFee).toBe((gross / 40n).toString());
    expect(quote.prepaidDurationSeconds).toBe(duration.toString());
    expect(
      quoteLoanInputSchema.safeParse({ ...borrow, collateralCount: (1n << 112n).toString() })
        .success,
    ).toBe(false);
    await expect(
      fixture({ available: 1n << 112n }).service.quoteLoan(borrow),
    ).rejects.toMatchObject({ code: 'LOAN_AMOUNT_OVERFLOW' });
  });
});

describe('loan plans and authority', () => {
  it('adds only BURN_TOKENS, preserves other grants, and protects the quoted gross debt', async () => {
    const { service } = fixture({
      burnPermission: false,
      packedPermissions: (1n << 7n) | (1n << 200n),
    });
    const quote = await service.quoteLoan(borrow);
    expect(quote.burnPermission.proposal).toMatchObject({
      addedPermissionIds: [11],
      preservedPermissionIds: [7, 200],
      resultingPermissionIds: [7, 11, 200],
    });
    const plan = await service.prepareBorrow({ ...borrow, account: holder });
    expect(plan.calls.map((call) => call.dependsOn)).toEqual([[], [0]]);
    const grant = decodeFunctionData({ abi: jbPermissionsAbi, data: plan.calls[0]!.data });
    expect(grant).toMatchObject({
      functionName: 'setPermissionsFor',
      args: [holder, { operator: getAddress(loans), projectId: 12n, permissionIds: [7, 11, 200] }],
    });
    const loanCall = decodeFunctionData({ abi: revLoansAbi, data: plan.calls[1]!.data });
    expect(loanCall).toMatchObject({
      functionName: 'borrowFrom',
      args: [12n, getAddress(NATIVE_TOKEN), 9900n, 1000n, beneficiary, 25n, holder],
    });
    expect(plan.calls.every((call) => call.value === '0')).toBe(true);
  });

  it('requires the appropriate delegated caller permission and holder-owned burn grant', async () => {
    await expect(
      fixture().service.prepareBorrow({ ...borrow, account: beneficiary }),
    ).rejects.toMatchObject({ code: 'MISSING_LOAN_PERMISSION' });
    await expect(
      fixture({ delegatedPermission: true, burnPermission: false }).service.prepareBorrow({
        ...borrow,
        account: beneficiary,
      }),
    ).rejects.toMatchObject({
      code: 'HOLDER_BURN_GRANT_REQUIRED',
      details: { account: holder, addedPermissionIds: [11] },
    });
    const delegated = await fixture({ delegatedPermission: true }).service.prepareBorrow({
      ...borrow,
      account: beneficiary,
    });
    expect(delegated.calls).toHaveLength(1);
    expect(delegated.account).toBe(beneficiary);
  });

  it('does not prepare zero debt or collateral the holder does not own', async () => {
    await expect(
      fixture({ available: 0n }).service.prepareBorrow({ ...borrow, account: holder }),
    ).rejects.toMatchObject({ code: 'NOTHING_BORROWABLE' });
    await expect(
      fixture({ holderBalance: 999n }).service.prepareBorrow({ ...borrow, account: holder }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_COLLATERAL' });
    const tiny = await fixture({ available: 1n }).service.prepareBorrow({
      ...borrow,
      account: holder,
    });
    expect(decodeFunctionData({ abi: revLoansAbi, data: tiny.calls[0]!.data }).args?.[2]).toBe(1n);
  });

  it('reads NFT ownership, source fees and the exact inclusive repayment deadline', async () => {
    const atDeadline = await fixture({
      timestamp: (100n + duration).toString(),
      loanOwner: beneficiary,
    }).service.getLoan({ chainId: 8453, loanId: repay.loanId });
    expect(atDeadline).toMatchObject({
      nftOwner: beneficiary,
      expired: false,
      repaymentDeadline: (100n + duration).toString(),
      fullRepaymentSourceFee: '100',
      fullRepaymentAmount: '10100',
    });
    const expired = fixture({ timestamp: (101n + duration).toString() });
    expect(await expired.service.getLoan({ chainId: 8453, loanId: repay.loanId })).toMatchObject({
      expired: true,
      fullRepaymentAmount: null,
      fullRepaymentSourceFee: null,
    });
    expect(
      expired.readContract.mock.calls.some(
        ([request]) => request.functionName === 'determineSourceFeeAmount',
      ),
    ).toBe(false);
    await expect(expired.service.prepareRepay(repay)).rejects.toMatchObject({
      code: 'LOAN_EXPIRED',
    });
  });

  it('prepares native repayment with the explicit maximum and refund semantics', async () => {
    const plan = await fixture().service.prepareRepay(repay);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.value).toBe('10200');
    expect(plan.summary).toMatchObject({
      principal: '10000',
      sourceFee: '100',
      quotedRepayment: '10100',
      maximumRepayment: '10200',
      remainingDebt: '0',
    });
    expect(decodeFunctionData({ abi: revLoansAbi, data: plan.calls[0]!.data })).toMatchObject({
      functionName: 'repayLoan',
      args: [BigInt(repay.loanId), 10200n, 1000n, beneficiary, { amount: 0n, signature: '0x' }],
    });
  });

  it('prepares exact ERC20 maximum approvals with reset and ordered dependencies', async () => {
    const plan = await fixture({ sourceToken: token, allowance: 5n }).service.prepareRepay(repay);
    expect(plan.calls.map((call) => call.dependsOn)).toEqual([[], [0], [0, 1]]);
    expect(plan.calls.every((call) => call.value === '0')).toBe(true);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(loans),
      0n,
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[1]!.data }).args).toEqual([
      getAddress(loans),
      10200n,
    ]);
    expect(
      (await fixture({ sourceToken: token, allowance: 10200n }).service.prepareRepay(repay)).calls,
    ).toHaveLength(1);
  });

  it('uses remaining collateral capacity for partial repayment and retains NFT ownership', async () => {
    const plan = await fixture({ available: 100n, capacity: 4000n }).service.prepareRepay({
      ...repay,
      collateralCountToReturn: '500',
      maxRepayBorrowAmount: '6200',
    });
    expect(plan.summary).toMatchObject({
      principal: '6000',
      quotedRepayment: '6100',
      remainingDebt: '4000',
      effectiveCollateralReturned: '500',
      remainingLoanNftRecipient: holder,
    });
    const zeroCapacity = await fixture({ available: 0n, capacity: 0n }).service.prepareRepay({
      ...repay,
      collateralCountToReturn: '500',
    });
    expect(zeroCapacity.summary).toMatchObject({
      effectiveCollateralReturned: '1000',
      remainingDebt: '0',
    });
  });

  it('rejects wrong borrower, underfunded caps, impossible collateral and ambiguous partial quotes', async () => {
    await expect(
      fixture({ loanOwner: beneficiary }).service.prepareRepay(repay),
    ).rejects.toMatchObject({ code: 'MISSING_LOAN_PERMISSION' });
    await expect(
      fixture().service.prepareRepay({ ...repay, maxRepayBorrowAmount: '10099' }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_REPAYMENT_MAXIMUM',
      details: { required: '10100' },
    });
    await expect(
      fixture().service.prepareRepay({ ...repay, collateralCountToReturn: '1001' }),
    ).rejects.toMatchObject({ code: 'EXCESS_COLLATERAL_RETURN' });
    await expect(
      fixture({ capacity: 10001n }).service.prepareRepay({
        ...repay,
        collateralCountToReturn: '500',
      }),
    ).rejects.toMatchObject({ code: 'REMAINING_COLLATERAL_SUPPORTS_EXCESS_DEBT' });
    await expect(
      fixture({ delay: 2000n }).service.prepareRepay({ ...repay, collateralCountToReturn: '500' }),
    ).rejects.toMatchObject({ code: 'PARTIAL_REPAY_QUOTE_UNAVAILABLE' });
    await expect(fixture({ delay: 2000n }).service.prepareRepay(repay)).resolves.toMatchObject({
      operation: 'repay_loan',
    });
    await expect(
      fixture({ capacity: 10000n }).service.prepareRepay({
        ...repay,
        collateralCountToReturn: '0',
      }),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_REPAY' });
    await expect(
      fixture({ loanAmount: 0n }).service.getLoan({ chainId: 8453, loanId: repay.loanId }),
    ).rejects.toMatchObject({ code: 'INACTIVE_LOAN' });
  });
});

describe('verified sucker operations', () => {
  it('validates registration and account beneficiary before simulating the exact claim', async () => {
    const { service, simulateContract } = fixture();
    const plan = await service.prepareBridgeClaim(bridge);
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: sucker,
        account: holder,
        functionName: 'claim',
        blockNumber: 1234n,
        gas: 10_000_000n,
      }),
    );
    expect(plan.summary).toMatchObject({
      leafHash: suckerLeafHash(leaf),
      proofRoot,
      beneficiary: holder,
    });
    expect(decodeFunctionData({ abi: jbSuckerV6Abi, data: plan.calls[0]!.data })).toMatchObject({
      functionName: 'claim',
      args: [{ token, leaf, proof }],
    });
    await expect(
      fixture({ registered: false }).service.prepareBridgeClaim(bridge),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_SUCKER' });
    await expect(
      fixture({ suckerProjectId: 13n }).service.prepareBridgeClaim(bridge),
    ).rejects.toMatchObject({ code: 'SUCKER_PROJECT_MISMATCH' });
    await expect(
      fixture().service.prepareBridgeClaim({ ...bridge, account: beneficiary }),
    ).rejects.toMatchObject({ code: 'CLAIM_BENEFICIARY_MISMATCH' });
  });

  it('rejects executed or invalid proofs and accepts retained roots only through contract simulation', async () => {
    await expect(
      fixture({ executedHash: hash }).service.prepareBridgeClaim(bridge),
    ).rejects.toMatchObject({ code: 'CLAIM_ALREADY_EXECUTED' });
    await expect(
      fixture({ simulationFailure: true }).service.prepareBridgeClaim(bridge),
    ).rejects.toThrow('Exact simulation reverted');
    const retainedRoot = fixture({ inboxRoot: hash });
    expect((await retainedRoot.service.prepareBridgeClaim(bridge)).summary).toMatchObject({
      proofRoot,
      currentInboxRoot: hash,
    });
    expect(retainedRoot.simulateContract).toHaveBeenCalledOnce();
    expect(
      prepareBridgeClaimInputSchema.safeParse({
        ...bridge,
        claim: { ...bridge.claim, proof: proof.slice(1) },
      }).success,
    ).toBe(false);
    expect(
      prepareBridgeClaimInputSchema.safeParse({
        ...bridge,
        claim: { ...bridge.claim, leaf: { ...bridge.claim.leaf, index: '4294967296' } },
      }).success,
    ).toBe(false);
  });

  it('selects only a successful native transport budget and identifies accounting-only semantics', async () => {
    const { service, simulateContract } = fixture({
      transport: 'ccip',
      transportMinimum: 2_000_000_000_000_000n,
    });
    const plan = await service.prepareAccountingSync({
      project,
      account: holder,
      sucker,
      maxTransportValue: '3000000000000000',
    });
    expect(simulateContract.mock.calls.map(([request]) => request.value)).toEqual([
      1_000_000_000_000_000n,
      3_000_000_000_000_000n,
    ]);
    expect(plan.calls[0]?.value).toBe('3000000000000000');
    expect(plan.summary).toMatchObject({
      transport: 'ccip',
      accountingOnly: true,
      transfersProjectTokens: false,
      transfersTreasuryBacking: false,
      registryToRemoteFee: '0',
    });
    expect(decodeFunctionData({ abi: jbSuckerV6Abi, data: plan.calls[0]!.data }).functionName).toBe(
      'syncAccountingData',
    );
    expect(
      simulateContract.mock.calls.every(
        ([request]) => request.account === holder && request.blockNumber === 1234n,
      ),
    ).toBe(true);
  });

  it('never assumes zero-cost for unknown transport, uses LINK fallback, or exceeds the user budget', async () => {
    const request = { project, account: holder, sucker, maxTransportValue: '500000000000000' };
    const unknown = fixture({ transport: 'unknown' });
    await expect(unknown.service.prepareAccountingSync(request)).rejects.toMatchObject({
      code: 'UNKNOWN_SUCKER_TRANSPORT',
    });
    expect(unknown.simulateContract).not.toHaveBeenCalled();
    const exhausted = fixture({ transport: 'ccip', transportMinimum: 1_000_000_000_000_000n });
    await expect(exhausted.service.prepareAccountingSync(request)).rejects.toMatchObject({
      code: 'NO_VERIFIED_TRANSPORT_VALUE',
    });
    expect(exhausted.simulateContract.mock.calls.map(([candidate]) => candidate.value)).toEqual([
      500_000_000_000_000n,
    ]);
    const zeroCcip = fixture({ transport: 'ccip' });
    await expect(
      zeroCcip.service.prepareAccountingSync({ ...request, maxTransportValue: '0' }),
    ).rejects.toMatchObject({ code: 'NO_VERIFIED_TRANSPORT_VALUE' });
    expect(zeroCcip.simulateContract).not.toHaveBeenCalled();
    expect(
      (
        await fixture({ transport: 'native' }).service.prepareAccountingSync({
          ...request,
          maxTransportValue: '0',
        })
      ).calls[0]?.value,
    ).toBe('0');
    await expect(
      fixture({ registered: false }).service.prepareAccountingSync(request),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_SUCKER' });
  });
});
