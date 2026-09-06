import {
  NATIVE_TOKEN,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbSuckerRegistryAbi,
  jbTokensAbi,
  revDeployerAbi,
  revLoansAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import {
  buildBorrowTx,
  buildBridgeClaimTx,
  buildRepayLoanTx,
  buildSyncAccountingDataTx,
  CCIP_SUCKER_TRANSPORT_VALUES,
  NATIVE_SUCKER_TRANSPORT_VALUES,
  classifySuckerTransport,
  findSuckerTransportValue,
  jbSuckerV6Abi,
  loanOpeningAmounts,
  slippageFloor,
  suckerBranchRoot,
  suckerLeafHash,
  v6Address,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
} from 'viem';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import {
  addressSchema,
  chainIdSchema,
  hashSchema,
  positiveUintSchema,
  projectSchema,
  slippageSchema,
  uintSchema,
} from '../domain/schemas.js';
import type {
  ChainId,
  PlanDraft,
  PreparedCall,
  ProjectRef,
  RpcProvider,
  RpcSnapshot,
} from '../domain/types.js';

const nonzeroAddress = addressSchema.refine(
  (value) => value.toLowerCase() !== zeroAddress,
  'Cannot be the zero address.',
);
const collateralSchema = positiveUintSchema.refine(
  (value) => BigInt(value) < 1n << 112n,
  'Collateral must fit uint112.',
);
export const quoteLoanInputSchema = z
  .object({
    project: projectSchema,
    holder: nonzeroAddress,
    token: nonzeroAddress,
    collateralCount: collateralSchema,
    prepaidFeePercent: z.number().int().min(25).max(500),
    beneficiary: nonzeroAddress,
  })
  .strict();
export const prepareBorrowInputSchema = quoteLoanInputSchema
  .extend({ account: nonzeroAddress, slippageBps: slippageSchema })
  .strict();
export const getLoanInputSchema = z
  .object({ chainId: chainIdSchema, loanId: positiveUintSchema })
  .strict();
export const prepareRepayInputSchema = getLoanInputSchema
  .extend({
    account: nonzeroAddress,
    maxRepayBorrowAmount: uintSchema,
    collateralCountToReturn: uintSchema,
    beneficiary: nonzeroAddress,
  })
  .strict();
const proofSchema = z.tuple([
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
  hashSchema,
]);
export const bridgeClaimSchema = z
  .object({
    token: nonzeroAddress,
    leaf: z
      .object({
        index: uintSchema.refine(
          (value) => BigInt(value) < 1n << 32n,
          'Index must fit the depth-32 tree.',
        ),
        beneficiary: hashSchema,
        projectTokenCount: positiveUintSchema,
        terminalTokenAmount: uintSchema,
        metadata: hashSchema,
      })
      .strict(),
    proof: proofSchema,
  })
  .strict();
export const prepareBridgeClaimInputSchema = z
  .object({
    project: projectSchema,
    account: nonzeroAddress,
    sucker: nonzeroAddress,
    claim: bridgeClaimSchema,
  })
  .strict();
export const prepareAccountingSyncInputSchema = z
  .object({
    project: projectSchema,
    account: nonzeroAddress,
    sucker: nonzeroAddress,
    maxTransportValue: uintSchema.describe(
      'Maximum native wei attached to the accounting message; gas is additional.',
    ),
  })
  .strict();

// The SDK does not currently export JBFeelessAddresses. This is the exact v6 interface;
// its caller is the terminal's caller (REVLoans), not the end-user beneficiary.
const feelessAbi = parseAbi([
  'function isFeelessFor(address addr,uint256 projectId,address caller) view returns (bool)',
]);
const SIMULATION_GAS = 10_000_000n;
const sameAddress = (left: Address, right: Address) => left.toLowerCase() === right.toLowerCase();
const block = (snapshot: RpcSnapshot) => BigInt(snapshot.evidence.blockNumber);

function preparedCall(
  tx: {
    chainId: ChainId;
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    value?: bigint;
  },
  label: string,
  dependsOn: number[] = [],
): PreparedCall {
  const data = encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args });
  const decoded = decodeFunctionData({ abi: tx.abi, data });
  return {
    chainId: tx.chainId,
    to: tx.address,
    data,
    value: (tx.value ?? 0n).toString(),
    label,
    decoded: { functionName: decoded.functionName, args: decoded.args },
    dependsOn,
  };
}

function permissionIds(packed: bigint): number[] {
  const ids: number[] = [];
  for (let id = 1; id < 256; id++) if ((packed & (1n << BigInt(id))) !== 0n) ids.push(id);
  return ids;
}

/** Read-only quotes and bounded, unsigned plans for the canonical V6 extensions. */
export class ExtensionService {
  constructor(private readonly rpc: RpcProvider) {}

  private async revnet(project: ProjectRef, snapshot: RpcSnapshot) {
    const { client } = snapshot;
    const chainId = project.chainId;
    const projectId = BigInt(project.projectId);
    const deployer = v6Address('REVDeployer', chainId);
    const read = { address: deployer, abi: revDeployerAbi, blockNumber: block(snapshot) } as const;
    const [
      configurationHash,
      owner,
      loans,
      terminal,
      permissions,
      controller,
      directory,
      projects,
    ] = await Promise.all([
      client.readContract({
        ...read,
        functionName: 'hashedEncodedConfigurationOf',
        args: [projectId],
      }),
      client.readContract({ ...read, functionName: 'OWNER' }),
      client.readContract({ ...read, functionName: 'LOANS' }),
      client.readContract({ ...read, functionName: 'MULTI_TERMINAL' }),
      client.readContract({ ...read, functionName: 'PERMISSIONS' }),
      client.readContract({ ...read, functionName: 'CONTROLLER' }),
      client.readContract({ ...read, functionName: 'DIRECTORY' }),
      client.readContract({ ...read, functionName: 'PROJECTS' }),
    ]);
    if (configurationHash === zeroHash)
      throw new DomainError(
        'NOT_A_REVNET',
        'This project is not registered by the canonical REVDeployer.',
      );
    for (const [actual, expected] of [
      [loans, v6Address('REVLoans', chainId)],
      [terminal, v6Address('JBMultiTerminal', chainId)],
      [permissions, v6Address('JBPermissions', chainId)],
      [controller, v6Address('JBController', chainId)],
      [directory, v6Address('JBDirectory', chainId)],
      [projects, v6Address('JBProjects', chainId)],
    ] as const) {
      if (!sameAddress(actual, expected))
        throw new DomainError(
          'UNSUPPORTED_REVNET_DEPENDENCY',
          'The deployed revnet dependencies differ from the supported V6 contracts.',
        );
    }
    const [projectOwner, rules, activeController, loanTerminal] = await Promise.all([
      client.readContract({
        address: projects,
        abi: jbProjectsAbi,
        functionName: 'ownerOf',
        args: [projectId],
        blockNumber: block(snapshot),
      }),
      client.readContract({
        address: controller,
        abi: jbControllerAbi,
        functionName: 'currentRulesetOf',
        args: [projectId],
        blockNumber: block(snapshot),
      }),
      client.readContract({
        address: directory,
        abi: jbDirectoryAbi,
        functionName: 'controllerOf',
        args: [projectId],
        blockNumber: block(snapshot),
      }),
      client.readContract({
        address: loans,
        abi: revLoansAbi,
        functionName: 'TERMINAL',
        blockNumber: block(snapshot),
      }),
    ]);
    const dataHook = (rules[0].metadata >> 82n) & ((1n << 160n) - 1n);
    if (
      !sameAddress(projectOwner, owner) ||
      dataHook !== BigInt(owner) ||
      !sameAddress(activeController, controller) ||
      !sameAddress(loanTerminal, terminal) ||
      rules[0].id === 0
    ) {
      throw new DomainError(
        'UNSUPPORTED_REVNET_CONFIGURATION',
        'The live project owner, data hook, controller, or loan terminal is not the canonical revnet configuration.',
      );
    }
    return {
      projectId,
      configurationHash,
      owner,
      loans,
      terminal,
      permissions,
      controller,
      directory,
      projects,
    };
  }

  private async loanQuote(input: z.output<typeof quoteLoanInputSchema>, snapshot: RpcSnapshot) {
    const config = await this.revnet(input.project, snapshot);
    const { client } = snapshot;
    const pin = { blockNumber: block(snapshot) };
    const [
      context,
      revId,
      minPrepaid,
      maxPrepaid,
      revFeePercent,
      duration,
      feelessAddresses,
      burnAllowed,
      existingPermissions,
      tokenStore,
    ] = await Promise.all([
      client.readContract({
        ...pin,
        address: config.terminal,
        abi: jbMultiTerminalAbi,
        functionName: 'accountingContextForTokenOf',
        args: [config.projectId, input.token],
      }),
      client.readContract({
        ...pin,
        address: config.loans,
        abi: revLoansAbi,
        functionName: 'REV_ID',
      }),
      client.readContract({
        ...pin,
        address: config.loans,
        abi: revLoansAbi,
        functionName: 'MIN_PREPAID_FEE_PERCENT',
      }),
      client.readContract({
        ...pin,
        address: config.loans,
        abi: revLoansAbi,
        functionName: 'MAX_PREPAID_FEE_PERCENT',
      }),
      client.readContract({
        ...pin,
        address: config.loans,
        abi: revLoansAbi,
        functionName: 'REV_PREPAID_FEE_PERCENT',
      }),
      client.readContract({
        ...pin,
        address: config.loans,
        abi: revLoansAbi,
        functionName: 'LOAN_LIQUIDATION_DURATION',
      }),
      client.readContract({
        ...pin,
        address: config.terminal,
        abi: jbMultiTerminalAbi,
        functionName: 'FEELESS_ADDRESSES',
      }),
      client.readContract({
        ...pin,
        address: config.permissions,
        abi: jbPermissionsAbi,
        functionName: 'hasPermission',
        args: [config.loans, input.holder, config.projectId, 11n, true, true],
      }),
      client.readContract({
        ...pin,
        address: config.permissions,
        abi: jbPermissionsAbi,
        functionName: 'permissionsOf',
        args: [config.loans, input.holder, config.projectId],
      }),
      client.readContract({
        ...pin,
        address: config.controller,
        abi: jbControllerAbi,
        functionName: 'TOKENS',
      }),
    ]);
    if (!sameAddress(context.token, input.token))
      throw new DomainError(
        'INVALID_LOAN_SOURCE',
        'The requested token has no accounting context on the canonical revnet terminal.',
      );
    if (minPrepaid !== 25n || maxPrepaid !== 500n || revFeePercent !== 10n) {
      throw new DomainError(
        'UNSUPPORTED_LOAN_FEES',
        'The deployed loan fee constants differ from the supported SDK fee model.',
      );
    }
    const [
      borrowable,
      sourceTokenSurplus,
      ownerFeeless,
      loansFeeless,
      revFeeTerminal,
      holderBalance,
    ] = await Promise.all([
      client.readContract({
        ...pin,
        address: config.loans,
        abi: revLoansAbi,
        functionName: 'borrowableAmountFrom',
        args: [
          config.projectId,
          BigInt(input.collateralCount),
          BigInt(context.decimals),
          BigInt(context.currency),
        ],
      }),
      client.readContract({
        ...pin,
        address: config.terminal,
        abi: jbMultiTerminalAbi,
        functionName: 'currentSurplusOf',
        args: [config.projectId, [input.token], BigInt(context.decimals), BigInt(context.currency)],
      }),
      client.readContract({
        ...pin,
        address: feelessAddresses,
        abi: feelessAbi,
        functionName: 'isFeelessFor',
        args: [config.owner, config.projectId, config.loans],
      }),
      client.readContract({
        ...pin,
        address: feelessAddresses,
        abi: feelessAbi,
        functionName: 'isFeelessFor',
        args: [config.loans, config.projectId, config.loans],
      }),
      client.readContract({
        ...pin,
        address: config.directory,
        abi: jbDirectoryAbi,
        functionName: 'primaryTerminalOf',
        args: [revId, input.token],
      }),
      client.readContract({
        ...pin,
        address: tokenStore,
        abi: jbTokensAbi,
        functionName: 'totalBalanceOf',
        args: [input.holder, config.projectId],
      }),
    ]);
    if (borrowable[0] >= 1n << 112n)
      throw new DomainError(
        'LOAN_AMOUNT_OVERFLOW',
        'The quoted gross loan exceeds the loan contract uint112 limit.',
      );
    // REVLoans values all accepted terminal assets together. The actual allowance draw is
    // constrained to this one source token; aggregate backing cannot settle another asset.
    // Do not cap the quote to sourceTokenSurplus: borrowFrom recomputes its own aggregate
    // amount, so a lower minBorrowAmount would still attempt the same failing withdrawal.
    if (borrowable[0] > sourceTokenSurplus) {
      throw new DomainError(
        'INSUFFICIENT_LOAN_SOURCE_SURPLUS',
        'The aggregate loan quote exceeds the surplus held in the requested source token. This borrow cannot execute with the proposed collateral; no permission grant should be submitted.',
        {
          details: {
            project: input.project,
            token: input.token,
            decimals: context.decimals,
            currency: context.currency,
            quotedAggregateGrossDebt: borrowable[0].toString(),
            grossEconomicCapacity: borrowable[1].toString(),
            sourceTokenSurplus: sourceTokenSurplus.toString(),
            evidence: [snapshot.evidence],
          },
        },
      );
    }
    const fees = loanOpeningAmounts({
      grossBorrowAmount: borrowable[0],
      prepaidSourceFeePercent: BigInt(input.prepaidFeePercent),
      protocolFeeApplies: !ownerFeeless && !loansFeeless,
      revFeeApplies: !sameAddress(revFeeTerminal, zeroAddress),
    });
    const preservedPermissionIds = permissionIds(existingPermissions);
    const grant = burnAllowed
      ? null
      : {
          account: input.holder,
          operator: config.loans,
          projectId: input.project.projectId,
          addedPermissionIds: [11],
          preservedPermissionIds,
          resultingPermissionIds: permissionIds(existingPermissions | (1n << 11n)),
        };
    return {
      config,
      result: {
        project: input.project,
        holder: input.holder,
        beneficiary: input.beneficiary,
        token: input.token,
        decimals: context.decimals,
        currency: context.currency,
        collateralCount: input.collateralCount,
        holderBalance: holderBalance.toString(),
        holderHasCollateral: holderBalance >= BigInt(input.collateralCount),
        availableGrossDebt: borrowable[0].toString(),
        grossEconomicCapacity: borrowable[1].toString(),
        sourceTokenSurplus: sourceTokenSurplus.toString(),
        protocolFee: fees.protocolFee.toString(),
        protocolFeeExemption: { ownerFeeless, loansFeeless, caller: config.loans },
        prepaidSourceFee: fees.sourceFee.toString(),
        revFeeIfPaymentSucceeds: fees.revFee.toString(),
        liquidProceeds: {
          minimumAtQuotedDebt: fees.netBorrowAmount.toString(),
          maximumIfFeePaymentsFail: (fees.grossBorrowAmount - fees.protocolFee).toString(),
          semantics:
            'The lower amount assumes both fee payments succeed. Failed REV/source payments return those amounts to the beneficiary. Fee payments may also mint project tokens; their amounts are not quoted here.',
        },
        prepaidFeePercent: input.prepaidFeePercent,
        prepaidDurationSeconds: (
          (BigInt(input.prepaidFeePercent) * duration) /
          maxPrepaid
        ).toString(),
        liquidationDurationSeconds: duration.toString(),
        nftRecipient: input.holder,
        burnPermission: { granted: burnAllowed, proposal: grant },
        evidence: [snapshot.evidence],
        warnings: [
          'Collateral is burned on borrow and reminted on repayment. Debt is the gross amount, not the liquid proceeds.',
          'This is a block-pinned quote; execution, fee-payment outcomes, and future rulesets can change the result.',
        ],
      },
    };
  }

  async quoteLoan(raw: z.input<typeof quoteLoanInputSchema>) {
    const input = quoteLoanInputSchema.parse(raw);
    return (await this.loanQuote(input, await this.rpc.snapshot(input.project.chainId))).result;
  }

  async prepareBorrow(raw: z.input<typeof prepareBorrowInputSchema>): Promise<PlanDraft> {
    const input = prepareBorrowInputSchema.parse(raw);
    const snapshot = await this.rpc.snapshot(input.project.chainId);
    const { config, result: quote } = await this.loanQuote(input, snapshot);
    if (!quote.holderHasCollateral)
      throw new DomainError(
        'INSUFFICIENT_COLLATERAL',
        'The holder has fewer project tokens than the proposed collateral.',
      );
    if (BigInt(quote.availableGrossDebt) === 0n)
      throw new DomainError(
        'NOTHING_BORROWABLE',
        'The live borrow quote is zero; available surplus or the cash-out delay prevents a loan.',
      );
    await this.requirePermission(
      snapshot,
      config.permissions,
      input.account,
      input.holder,
      config.projectId,
      37n,
    );
    const calls: PreparedCall[] = [];
    if (quote.burnPermission.proposal) {
      if (!sameAddress(input.account, input.holder)) {
        throw new DomainError(
          'HOLDER_BURN_GRANT_REQUIRED',
          'The token holder must review and grant REVLoans permission to burn collateral before the delegated borrow can proceed.',
          { details: quote.burnPermission.proposal },
        );
      }
      calls.push(
        preparedCall(
          {
            chainId: input.project.chainId,
            address: config.permissions,
            abi: jbPermissionsAbi,
            functionName: 'setPermissionsFor',
            args: [
              input.holder,
              {
                operator: config.loans,
                projectId: config.projectId,
                permissionIds: quote.burnPermission.proposal.resultingPermissionIds,
              },
            ],
          },
          'Grant REVLoans BURN_TOKENS (11), preserving existing project permissions',
        ),
      );
    }
    const minimumGrossDebt = slippageFloor(
      BigInt(quote.availableGrossDebt),
      BigInt(input.slippageBps),
    );
    const tx = buildBorrowTx({
      chainId: input.project.chainId,
      revnetId: config.projectId,
      holder: input.holder,
      token: input.token,
      minBorrowAmount: minimumGrossDebt,
      collateralCount: BigInt(input.collateralCount),
      beneficiary: input.beneficiary,
      prepaidFeePercent: BigInt(input.prepaidFeePercent),
    });
    calls.push(
      preparedCall(
        tx,
        'Borrow against burned revnet collateral; loan NFT goes to holder',
        calls.map((_, index) => index),
      ),
    );
    return {
      operation: 'borrow',
      project: input.project,
      account: input.account,
      calls,
      evidence: [snapshot.evidence],
      summary: {
        quote,
        minimumGrossDebt: minimumGrossDebt.toString(),
        slippageBps: input.slippageBps,
        minimumAppliesTo:
          'Gross debt before fees. The contract does not expose a minimum liquid-proceeds argument.',
      },
      warnings: quote.warnings,
    };
  }

  private async requirePermission(
    snapshot: RpcSnapshot,
    permissions: Address,
    account: Address,
    holder: Address,
    projectId: bigint,
    permissionId: bigint,
  ) {
    if (sameAddress(account, holder)) return;
    const permitted = await snapshot.client.readContract({
      address: permissions,
      abi: jbPermissionsAbi,
      functionName: 'hasPermission',
      args: [account, holder, projectId, permissionId, true, true],
      blockNumber: block(snapshot),
    });
    if (!permitted)
      throw new DomainError(
        'MISSING_LOAN_PERMISSION',
        `The caller is neither the owner nor an operator with permission ${permissionId}.`,
      );
  }

  private async liveLoan(chainId: ChainId, loanId: bigint, snapshot: RpcSnapshot) {
    const loans = v6Address('REVLoans', chainId);
    const read = { address: loans, abi: revLoansAbi, blockNumber: block(snapshot) } as const;
    const [loan, holder, projectId, duration] = await Promise.all([
      snapshot.client.readContract({ ...read, functionName: 'loanOf', args: [loanId] }),
      snapshot.client.readContract({ ...read, functionName: 'ownerOf', args: [loanId] }),
      snapshot.client.readContract({ ...read, functionName: 'revnetIdOfLoanWith', args: [loanId] }),
      snapshot.client.readContract({ ...read, functionName: 'LOAN_LIQUIDATION_DURATION' }),
    ]);
    if (
      loan.amount === 0n ||
      loan.collateral === 0n ||
      sameAddress(holder, zeroAddress) ||
      projectId === 0n
    ) {
      throw new DomainError(
        'INACTIVE_LOAN',
        'The loan does not exist or was repaid, reallocated, or liquidated.',
      );
    }
    const deadline = BigInt(loan.createdAt) + duration;
    const expired = BigInt(snapshot.evidence.timestamp) > deadline;
    const fullRepaymentSourceFee = expired
      ? null
      : await snapshot.client.readContract({
          ...read,
          functionName: 'determineSourceFeeAmount',
          args: [loan, loan.amount],
        });
    return { loans, loan, holder, projectId, deadline, expired, fullRepaymentSourceFee };
  }

  async getLoan(raw: z.input<typeof getLoanInputSchema>) {
    const input = getLoanInputSchema.parse(raw);
    const snapshot = await this.rpc.snapshot(input.chainId);
    const live = await this.liveLoan(input.chainId, BigInt(input.loanId), snapshot);
    return {
      chainId: input.chainId,
      loanId: input.loanId,
      project: { chainId: input.chainId, projectId: live.projectId.toString(), version: 6 },
      loanContract: live.loans,
      nftOwner: live.holder,
      loan: live.loan,
      repaymentDeadline: live.deadline.toString(),
      expired: live.expired,
      fullRepaymentSourceFee: live.fullRepaymentSourceFee?.toString() ?? null,
      fullRepaymentAmount:
        live.fullRepaymentSourceFee === null
          ? null
          : (live.loan.amount + live.fullRepaymentSourceFee).toString(),
      evidence: [snapshot.evidence],
      semantics:
        'The ERC-721 owner controls the loan. Partial repayment replaces the loan ID and preserves its creation time. Expiry is strictly after the deadline.',
    };
  }

  async prepareRepay(raw: z.input<typeof prepareRepayInputSchema>): Promise<PlanDraft> {
    const input = prepareRepayInputSchema.parse(raw);
    const snapshot = await this.rpc.snapshot(input.chainId);
    const live = await this.liveLoan(input.chainId, BigInt(input.loanId), snapshot);
    if (live.expired)
      throw new DomainError(
        'LOAN_EXPIRED',
        'The repayment deadline has passed; this loan can only be liquidated.',
      );
    const project: ProjectRef = {
      chainId: input.chainId,
      projectId: live.projectId.toString(),
      version: 6,
    };
    const config = await this.revnet(project, snapshot);
    await this.requirePermission(
      snapshot,
      config.permissions,
      input.account,
      live.holder,
      live.projectId,
      39n,
    );
    let collateralToReturn = BigInt(input.collateralCountToReturn);
    if (collateralToReturn > live.loan.collateral)
      throw new DomainError(
        'EXCESS_COLLATERAL_RETURN',
        'Requested returned collateral exceeds this loan’s collateral.',
      );
    let newDebt = 0n;
    if (collateralToReturn < live.loan.collateral) {
      const [delay, context] = await Promise.all([
        snapshot.client.readContract({
          address: config.owner,
          abi: revOwnerAbi,
          functionName: 'cashOutDelayOf',
          args: [live.projectId],
          blockNumber: block(snapshot),
        }),
        snapshot.client.readContract({
          address: config.terminal,
          abi: jbMultiTerminalAbi,
          functionName: 'accountingContextForTokenOf',
          args: [live.projectId, live.loan.sourceToken],
          blockNumber: block(snapshot),
        }),
      ]);
      if (delay > BigInt(snapshot.evidence.timestamp)) {
        throw new DomainError(
          'PARTIAL_REPAY_QUOTE_UNAVAILABLE',
          'During a cash-out delay the public capacity view returns zero, while partial repayment uses uncensored capacity. A full repayment can be prepared.',
        );
      }
      if (!sameAddress(context.token, live.loan.sourceToken))
        throw new DomainError(
          'INVALID_LOAN_SOURCE',
          'The loan source token has no current accounting context.',
        );
      const capacity = await snapshot.client.readContract({
        address: live.loans,
        abi: revLoansAbi,
        functionName: 'borrowableAmountFrom',
        args: [
          live.projectId,
          live.loan.collateral - collateralToReturn,
          BigInt(context.decimals),
          BigInt(context.currency),
        ],
        blockNumber: block(snapshot),
      });
      newDebt = capacity[1];
      if (newDebt === 0n) collateralToReturn = live.loan.collateral;
    }
    if (newDebt > live.loan.amount)
      throw new DomainError(
        'REMAINING_COLLATERAL_SUPPORTS_EXCESS_DEBT',
        'Remaining collateral would create more debt than the current loan; return more collateral or use a separately reviewed reallocation.',
      );
    const principal = live.loan.amount - newDebt;
    if (principal === 0n && collateralToReturn === 0n)
      throw new DomainError(
        'NOTHING_TO_REPAY',
        'This request would repay no debt and return no collateral.',
      );
    const sourceFee = await snapshot.client.readContract({
      address: live.loans,
      abi: revLoansAbi,
      functionName: 'determineSourceFeeAmount',
      args: [live.loan, principal],
      blockNumber: block(snapshot),
    });
    const required = principal + sourceFee;
    const maximum = BigInt(input.maxRepayBorrowAmount);
    if (maximum < required)
      throw new DomainError(
        'INSUFFICIENT_REPAYMENT_MAXIMUM',
        'The maximum repayment is below the live principal plus source fee.',
        {
          details: {
            required: required.toString(),
            principal: principal.toString(),
            sourceFee: sourceFee.toString(),
          },
        },
      );
    const calls: PreparedCall[] = [];
    const native = sameAddress(live.loan.sourceToken, NATIVE_TOKEN);
    if (!native && maximum > 0n) {
      const allowance = await snapshot.client.readContract({
        address: live.loan.sourceToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [input.account, live.loans],
        blockNumber: block(snapshot),
      });
      // A zero-reset makes the exact allowance change compatible with USDT-style tokens.
      if (allowance < maximum) {
        if (allowance > 0n)
          calls.push(
            preparedCall(
              {
                chainId: input.chainId,
                address: live.loan.sourceToken,
                abi: erc20Abi,
                functionName: 'approve',
                args: [live.loans, 0n],
              },
              'Reset existing loan repayment token allowance',
            ),
          );
        calls.push(
          preparedCall(
            {
              chainId: input.chainId,
              address: live.loan.sourceToken,
              abi: erc20Abi,
              functionName: 'approve',
              args: [live.loans, maximum],
            },
            'Approve exact maximum repayment to REVLoans',
            calls.map((_, index) => index),
          ),
        );
      }
    }
    calls.push(
      preparedCall(
        buildRepayLoanTx({
          chainId: input.chainId,
          loanId: BigInt(input.loanId),
          maxRepayBorrowAmount: maximum,
          collateralCountToReturn: BigInt(input.collateralCountToReturn),
          beneficiary: input.beneficiary,
          value: native ? maximum : 0n,
        }),
        'Repay loan and remint collateral to beneficiary',
        calls.map((_, index) => index),
      ),
    );
    return {
      operation: 'repay_loan',
      account: input.account,
      project,
      calls,
      evidence: [snapshot.evidence],
      summary: {
        loanId: input.loanId,
        nftOwner: live.holder,
        beneficiary: input.beneficiary,
        sourceToken: live.loan.sourceToken,
        principal: principal.toString(),
        sourceFee: sourceFee.toString(),
        quotedRepayment: required.toString(),
        maximumRepayment: input.maxRepayBorrowAmount,
        effectiveCollateralReturned: collateralToReturn.toString(),
        remainingDebt: newDebt.toString(),
        remainingLoanNftRecipient: newDebt > 0n ? live.holder : null,
        repaymentDeadline: live.deadline.toString(),
      },
      warnings: [
        'The full maximum is collected first; excess is refunded to the caller. Fee-on-transfer repayment tokens are rejected by REVLoans.',
        'Partial repayment burns the old loan NFT and issues a new ID to its current owner, retaining the original liquidation deadline.',
      ],
    };
  }

  private async verifySucker(project: ProjectRef, sucker: Address, snapshot: RpcSnapshot) {
    const registered = await snapshot.client.readContract({
      address: v6Address('JBSuckerRegistry', project.chainId),
      abi: jbSuckerRegistryAbi,
      functionName: 'isSuckerOf',
      args: [BigInt(project.projectId), sucker],
      blockNumber: block(snapshot),
    });
    if (!registered)
      throw new DomainError(
        'UNTRUSTED_SUCKER',
        'This sucker was not registered for the requested V6 project.',
      );
    const actualProjectId = await snapshot.client.readContract({
      address: sucker,
      abi: jbSuckerV6Abi,
      functionName: 'projectId',
      blockNumber: block(snapshot),
    });
    if (actualProjectId !== BigInt(project.projectId))
      throw new DomainError(
        'SUCKER_PROJECT_MISMATCH',
        'The sucker reports a different project ID.',
      );
  }

  async prepareBridgeClaim(raw: z.input<typeof prepareBridgeClaimInputSchema>): Promise<PlanDraft> {
    const input = prepareBridgeClaimInputSchema.parse(raw);
    const snapshot = await this.rpc.snapshot(input.project.chainId);
    await this.verifySucker(input.project, input.sucker, snapshot);
    if (
      input.claim.leaf.beneficiary.toLowerCase() !== pad(input.account, { size: 32 }).toLowerCase()
    ) {
      throw new DomainError(
        'CLAIM_BENEFICIARY_MISMATCH',
        'This claim pays a different beneficiary than the reviewing account.',
      );
    }
    const claim = {
      token: input.claim.token,
      proof: input.claim.proof,
      leaf: {
        index: BigInt(input.claim.leaf.index),
        beneficiary: input.claim.leaf.beneficiary,
        projectTokenCount: BigInt(input.claim.leaf.projectTokenCount),
        terminalTokenAmount: BigInt(input.claim.leaf.terminalTokenAmount),
        metadata: input.claim.leaf.metadata,
      },
    };
    const leafHash = suckerLeafHash(claim.leaf);
    const proofRoot = suckerBranchRoot(leafHash, claim.proof, Number(claim.leaf.index));
    const [executedHash, inbox] = await Promise.all([
      snapshot.client.readContract({
        address: input.sucker,
        abi: jbSuckerV6Abi,
        functionName: 'executedLeafHashOf',
        args: [claim.token, claim.leaf.index],
        blockNumber: block(snapshot),
      }),
      snapshot.client.readContract({
        address: input.sucker,
        abi: jbSuckerV6Abi,
        functionName: 'inboxOf',
        args: [claim.token],
        blockNumber: block(snapshot),
      }),
    ]);
    if (executedHash !== zeroHash)
      throw new DomainError(
        'CLAIM_ALREADY_EXECUTED',
        'This claim index has already been executed. Do not submit it again.',
      );
    const tx = buildBridgeClaimTx({ chainId: input.project.chainId, sucker: input.sucker, claim });
    // The contract retains four accepted roots. A proof need not match the newest inbox root:
    // exact simulation checks the actual retained-root set, beneficiary and minting paths.
    await snapshot.client.simulateContract({
      ...tx,
      account: input.account,
      blockNumber: block(snapshot),
      gas: SIMULATION_GAS,
    });
    return {
      operation: 'bridge_claim',
      account: input.account,
      project: input.project,
      calls: [preparedCall(tx, 'Claim bridged project tokens and settle treasury backing')],
      evidence: [snapshot.evidence],
      summary: {
        claim: input.claim,
        leafHash,
        proofRoot,
        currentInboxRoot: inbox.root,
        rootValidation:
          'The exact claim simulated successfully against the contract’s current or retained accepted roots.',
        alreadyExecuted: false,
        beneficiary: input.account,
      },
      warnings: [
        'A competing claim may execute this leaf before submission. Refresh its executed status and simulate again before signing.',
      ],
    };
  }

  async prepareAccountingSync(
    raw: z.input<typeof prepareAccountingSyncInputSchema>,
  ): Promise<PlanDraft> {
    const input = prepareAccountingSyncInputSchema.parse(raw);
    const snapshot = await this.rpc.snapshot(input.project.chainId);
    await this.verifySucker(input.project, input.sucker, snapshot);
    // RpcProvider.snapshot returns a client that pins nested SDK calls as well as direct reads.
    const transport = await classifySuckerTransport(snapshot.client, input.sucker);
    if (transport === 'unknown')
      throw new DomainError(
        'UNKNOWN_SUCKER_TRANSPORT',
        'The bridge transport could not be positively identified. No fee value can be prepared.',
      );
    const budget = BigInt(input.maxTransportValue);
    const tiers =
      transport === 'ccip' ? CCIP_SUCKER_TRANSPORT_VALUES : NATIVE_SUCKER_TRANSPORT_VALUES;
    const candidates = [...new Set([...tiers.filter((value) => value <= budget), budget])]
      .filter((value) => transport !== 'ccip' || value > 0n)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const value = await findSuckerTransportValue(candidates, (candidate) =>
      snapshot.client.simulateContract({
        ...buildSyncAccountingDataTx({
          chainId: input.project.chainId,
          sucker: input.sucker,
          value: candidate,
        }),
        account: input.account,
        blockNumber: block(snapshot),
        gas: SIMULATION_GAS,
      }),
    );
    if (value === null)
      throw new DomainError(
        'NO_VERIFIED_TRANSPORT_VALUE',
        'No exact accounting-sync transaction simulated successfully within the native budget. The transport fee, account balance, bridge state, or RPC may prevent it.',
        {
          details: {
            transport,
            maxTransportValue: input.maxTransportValue,
            triedValues: candidates.map((candidate) => candidate.toString()),
          },
        },
      );
    const tx = buildSyncAccountingDataTx({
      chainId: input.project.chainId,
      sucker: input.sucker,
      value,
    });
    return {
      operation: 'sync_accounting',
      account: input.account,
      project: input.project,
      calls: [preparedCall(tx, 'Send accounting data across the verified bridge')],
      evidence: [snapshot.evidence],
      summary: {
        transport,
        attachedNativeValue: value.toString(),
        maxTransportValue: input.maxTransportValue,
        accountingOnly: true,
        transfersProjectTokens: false,
        transfersTreasuryBacking: false,
        registryToRemoteFee: '0',
        valueSelection:
          'First exact successful simulation in bounded ascending candidates; this is an attached budget, not an exact bridge fee quote.',
      },
      warnings: [
        'Accounting sync updates remote economic observations asynchronously. It does not transfer balances or complete token claims.',
        'Accounting messages do not charge the registry toRemote fee. Native transport fees may change before execution; gas is additional.',
      ],
    };
  }
}
