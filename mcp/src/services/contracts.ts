import * as sdk from '@bananapus/nana-sdk-core';
import { jbSuckerV6Abi } from '@bananapus/nana-sdk-core/v6';
import { decodeFunctionData, isAddressEqual, type Abi, type Address, type Hex } from 'viem';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import type { ChainId } from '../domain/types.js';
import {
  deploymentAddress,
  deploymentAddresses,
  rollout,
  routerGatewayAbi,
  ratioPriceFeedAbi,
} from './rollout.js';

/** Canonical JBDeadline approval hooks, one per duration. Addresses come from the SDK registry. */
const DEADLINES: Record<string, Abi> = {
  JBDeadline3Hours: sdk.jbDeadline3HoursAbi,
  JBDeadline1Day: sdk.jbDeadline1DayAbi,
  JBDeadline3Days: sdk.jbDeadline3DaysAbi,
  JBDeadline7Days: sdk.jbDeadline7DaysAbi,
};

export function canonicalDeadline(chainId: ChainId, hook: Address): string | undefined {
  return Object.keys(DEADLINES).find((name) => {
    const address = deploymentAddress(name, chainId);
    return address !== undefined && isAddressEqual(address, hook);
  });
}

/** One CCIP sucker deployer per lane: chain ID -> peer chain ID -> deployer. */
const CCIP_DEPLOYERS =
  (sdk.CCIP_SUCKER_DEPLOYER_ADDRESSES as Record<string, Record<string, Record<string, string>>>)[
    '6'
  ] ?? {};

const ABI_REGISTRY: Record<string, Abi> = {
  ...DEADLINES,
  JBCCIPSuckerDeployer: sdk.jbccipSuckerDeployerAbi,
  JBProjects: sdk.jbProjectsAbi,
  JBDirectory: sdk.jbDirectoryAbi,
  JBController: sdk.jbControllerAbi,
  JBMultiTerminal: sdk.jbMultiTerminalAbi,
  JBTerminalStore: sdk.jbTerminalStoreAbi,
  JBRulesets: sdk.jbRulesetsAbi,
  JBSplits: sdk.jbSplitsAbi,
  JBFundAccessLimits: sdk.jbFundAccessLimitsAbi,
  JBTokens: sdk.jbTokensAbi,
  JBPermissions: sdk.jbPermissionsAbi,
  JBPrices: sdk.jbPricesAbi,
  JB721TiersHook: sdk.jb721TiersHookAbi,
  JB721TiersHookStore: sdk.jb721TiersHookStoreAbi,
  JB721TiersHookDeployer: sdk.jb721TiersHookDeployerAbi,
  JB721TiersHookProjectDeployer: sdk.jb721TiersHookProjectDeployerAbi,
  JBBuybackHook: sdk.jbBuybackHookAbi,
  JBBuybackHookRegistry: sdk.jbBuybackHookRegistryAbi,
  JBRouterTerminal: sdk.jbRouterTerminalAbi,
  JBRouterTerminalRegistry: sdk.jbRouterTerminalRegistryAbi,
  JBRouterTerminalGateway: routerGatewayAbi,
  JBRatioPriceFeed: ratioPriceFeedAbi,
  JBSuckerRegistry: sdk.jbSuckerRegistryAbi,
  JBSucker: jbSuckerV6Abi,
  JBOmnichainDeployer: sdk.jbOmnichainDeployerAbi,
  JBAddressRegistry: sdk.jbAddressRegistryAbi,
  REVDeployer: sdk.revDeployerAbi,
  REVLoans: sdk.revLoansAbi,
  REVOwner: sdk.revOwnerAbi,
  ERC2771Forwarder: sdk.erc2771ForwarderAbi,
};

/** The ABI of the canonical contract at an address on a chain, current or retired. */
export function abiAt(chainId: ChainId, address: Address): Abi | undefined {
  const name = Object.keys(ABI_REGISTRY).find((item) =>
    deploymentAddresses(item, chainId).some((deployed) => isAddressEqual(deployed, address)),
  );
  return name === undefined ? undefined : (rollout.contracts[name]?.abi ?? ABI_REGISTRY[name]);
}

export class ContractService {
  catalog() {
    return {
      version: 6,
      source: '@bananapus/nana-sdk-core@3.0.0',
      contracts: Object.entries(ABI_REGISTRY).map(([name, abi]) => ({
        name,
        abiEntries: rollout.contracts[name]?.abi.length ?? abi.length,
        deployments: rollout.contracts[name]
          ? Object.fromEntries(
              rollout.contracts[name]!.deployments.filter((item) => !item.retired).map((item) => [
                item.chainId,
                item.address,
              ]),
            )
          : name === 'JBCCIPSuckerDeployer'
            ? CCIP_DEPLOYERS
            : ((sdk.jbContractAddress['6'] as Record<string, Partial<Record<ChainId, string>>>)[
                name
              ] ?? {}),
        ...(rollout.contracts[name]
          ? {
              generations: rollout.contracts[name]!.deployments,
              deploymentSource: { repository: rollout.source, commit: rollout.commit },
            }
          : {}),
        identity:
          name === 'JBSucker'
            ? 'project-instance'
            : name === 'JBCCIPSuckerDeployer'
              ? 'sdk-deployment-registry-by-peer-chain'
              : rollout.contracts[name]
                ? 'deployment-records'
                : 'sdk-deployment-registry',
      })),
      warning:
        'Deployment records describe executed deployments per chain. Mainnet proposals are not active deployments. Retired implementations remain available for history and projects that have not migrated. Resolve registry -> gateway -> ROUTER and hookOf on-chain; an address is provenance, not a bytecode safety audit.',
    };
  }

  get(name: string, chainId?: ChainId, functionName?: string) {
    const abi = this.abi(name);
    const entries = functionName
      ? abi.filter((item) => 'name' in item && item.name === functionName)
      : abi;
    if (functionName && entries.length === 0)
      throw new DomainError(
        'FUNCTION_NOT_FOUND',
        'The named function or event is not in this contract ABI.',
      );
    return {
      version: 6,
      name,
      source: rollout.contracts[name] ? rollout.source : '@bananapus/nana-sdk-core@3.0.0',
      ...(chainId === undefined
        ? {}
        : name === 'JBCCIPSuckerDeployer'
          ? { chainId, addressByPeerChainId: CCIP_DEPLOYERS[chainId] ?? {} }
          : { chainId, address: deploymentAddress(name, chainId) ?? null }),
      ...(rollout.contracts[name]
        ? {
            generations: rollout.contracts[name]!.deployments.filter(
              (item) => chainId === undefined || item.chainId === chainId,
            ),
            deploymentSource: { repository: rollout.source, commit: rollout.commit },
          }
        : {}),
      abi: entries,
    };
  }

  decode(name: string, data: Hex) {
    try {
      return {
        contract: name,
        version: 6,
        ...(jsonSafe(decodeFunctionData({ abi: this.abi(name), data })) as object),
        warning:
          'Decoding identifies an ABI call, not its destination or authorization. No transaction is prepared or sent.',
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'CALLDATA_INVALID',
        'The calldata does not decode with the selected V6 ABI.',
      );
    }
  }

  private abi(name: string): Abi {
    if (Object.hasOwn(rollout.contracts, name)) return rollout.contracts[name]!.abi;
    if (!Object.hasOwn(ABI_REGISTRY, name))
      throw new DomainError(
        'CONTRACT_NOT_FOUND',
        `This contract is not in the supported V6 ABI registry. Known names: ${Object.keys(ABI_REGISTRY).join(', ')}.`,
      );
    return ABI_REGISTRY[name]!;
  }
}
