import * as sdk from '@bananapus/nana-sdk-core';
import { jbSuckerV6Abi } from '@bananapus/nana-sdk-core/v6';
import { decodeFunctionData, type Abi, type Hex } from 'viem';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import type { ChainId } from '../domain/types.js';

const ABI_REGISTRY: Record<string, Abi> = {
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
  JBSuckerRegistry: sdk.jbSuckerRegistryAbi,
  JBSucker: jbSuckerV6Abi,
  JBOmnichainDeployer: sdk.jbOmnichainDeployerAbi,
  JBAddressRegistry: sdk.jbAddressRegistryAbi,
  REVDeployer: sdk.revDeployerAbi,
  REVLoans: sdk.revLoansAbi,
  REVOwner: sdk.revOwnerAbi,
  ERC2771Forwarder: sdk.erc2771ForwarderAbi,
};

export class ContractService {
  catalog() {
    return {
      version: 6,
      source: '@bananapus/nana-sdk-core@2.4.0',
      contracts: Object.entries(ABI_REGISTRY).map(([name, abi]) => ({
        name,
        abiEntries: abi.length,
        deployments:
          (sdk.jbContractAddress['6'] as Record<string, Partial<Record<ChainId, string>>>)[name] ??
          {},
        identity: name === 'JBSucker' ? 'project-instance' : 'sdk-deployment-registry',
      })),
      warning:
        'A registry address is provenance, not a bytecode safety audit. Project-specific controllers, terminals, and hooks must be resolved on-chain.',
    };
  }

  get(name: string, chainId?: ChainId, functionName?: string) {
    const abi = this.abi(name);
    const registry = (
      sdk.jbContractAddress['6'] as Record<string, Partial<Record<ChainId, string>>>
    )[name];
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
      source: '@bananapus/nana-sdk-core@2.4.0',
      ...(chainId === undefined ? {} : { chainId, address: registry?.[chainId] ?? null }),
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
    if (!Object.hasOwn(ABI_REGISTRY, name))
      throw new DomainError(
        'CONTRACT_NOT_FOUND',
        'This contract is not in the supported V6 ABI registry.',
      );
    return ABI_REGISTRY[name]!;
  }
}
