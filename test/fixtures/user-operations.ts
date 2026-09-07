import { toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from '../../src/rest/auth/store.js';
import type { RestActor } from '../../src/rest/core.js';
import type { SmartAccountBinding } from '../../src/rest/smartAccounts/types.js';
import { fingerprint } from '../../src/rest/smartAccounts/service.js';
import type { StoredPlan } from '../../src/rest/transactions/types.js';
import {
  digest,
  type UserOperationClaim,
  type UserOperationRecord,
} from '../../src/rest/userOperations/store.js';
import {
  getUserOperationHash,
  normalizeUserOperation,
  userOperationCommitment,
} from '../../src/rest/userOperations/codec.js';
// Deterministic public test key, never funded and never used for network submission.
export const ownerKey = privateKeyToAccount(`0x${'11'.repeat(32)}`);
export const safe = '0x3333333333333333333333333333333333333333' as Address;
export const target = '0x2222222222222222222222222222222222222222' as Address;
export const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032' as Address;
export const h = (value: string): Hex => digest(value);
export function account(now: number, authorityChainId = 1): Account {
  return {
    id: `eip155:${authorityChainId}:${ownerKey.address.toLowerCase()}`,
    ownerAddress: ownerKey.address,
    authorityChainId,
    profile: { displayName: '', bio: '', avatarUri: null },
    createdAt: Math.floor(now / 1000),
    updatedAt: Math.floor(now / 1000),
  };
}
export function owner(value: Account): RestActor {
  return { accountId: value.id, principalId: `owner:${value.id}` };
}
export function binding(value: Account, now: number): SmartAccountBinding {
  const id = fingerprint({ ownerAccountId: value.id, wallet: safe, chainId: 1 });
  return {
    id,
    ownerAccountId: value.id,
    ownerAddress: value.ownerAddress,
    wallet: { chainId: 1, address: safe },
    manifestId: 'fixture-manifest',
    authorization: {
      digest: h(`binding:${value.id}`),
      nonce: h(`nonce:${value.id}`),
      expiresAt: Math.floor(now / 1000) + 300,
      method: 'safe-current-owner-threshold',
    },
    state: {
      chainId: 1,
      address: safe,
      manifestId: 'fixture-manifest',
      manifestRevision: h('manifest'),
      owners: [value.ownerAddress],
      threshold: 1,
      safeNonce: '0',
      stateHash: h('account-state'),
      evidence: {
        chainId: 1,
        blockNumber: '100',
        blockHash: h('block'),
        timestamp: String(Math.floor(now / 1000)),
        source: 'onchain',
      },
      codeHashes: [],
      modules: {
        stateHash: h('modules'),
        complete: true,
        arbitrarySigningDisabled: true,
        wildcardExecutionDisabled: true,
        details: {},
      },
      moduleConfigurationVerified: true,
      executionVerified: true,
    },
  };
}
export function plan(
  id: string,
  actor: RestActor,
  walletBinding: SmartAccountBinding,
  now: number,
  steps = 1,
): StoredPlan {
  return {
    id,
    actor,
    commitment: h(id),
    createdAt: now,
    expiresAt: now + 300_000,
    revision: 0,
    smartAccount: {
      bindingId: walletBinding.id,
      stateHash: walletBinding.state.stateHash,
      chainId: 1,
      address: safe,
      manifestRevision: walletBinding.state.manifestRevision,
    },
    draft: {
      operation: 'fixture',
      account: safe,
      evidence: [],
      summary: {},
      warnings: [],
      calls: Array.from({ length: steps }, (_, index) => ({
        chainId: 1,
        to: target,
        data: '0x1234',
        value: '0',
        label: `Fixture ${index}`,
        dependsOn: [],
        decoded: {},
      })),
    },
    steps: Array.from({ length: steps }, (_, index) => ({ index, state: 'waiting' })),
  };
}
export function record(value: StoredPlan, nonce = 1n): UserOperationRecord {
  const operation = normalizeUserOperation({
    sender: safe,
    nonce: toHex(nonce),
    callData: '0x1234',
    callGasLimit: '0x186a0',
    verificationGasLimit: '0x186a0',
    preVerificationGas: '0xc350',
    maxFeePerGas: '0x2',
    maxPriorityFeePerGas: '0x1',
    signature: '0x',
  });
  return {
    id: `uo:${value.id}`,
    actor: value.actor,
    planId: value.id,
    planCommitment: value.commitment,
    stepIndexes: value.steps.map((step) => step.index),
    chainId: 1,
    entryPoint,
    sender: safe,
    operation,
    operationHash: getUserOperationHash(operation, entryPoint, 1),
    preparationKey: `prepare:${value.id}`,
    inputHash: h(`input:${value.id}`),
    commitment: h(`review:${value.id}`),
    accountBindingId: value.smartAccount!.bindingId,
    accountStateHash: value.smartAccount!.stateHash,
    gasPolicyId: 'fixture-gas',
    providerId: 'fixture-provider',
    createdAt: value.createdAt,
    expiresAt: value.expiresAt - 1000,
    revision: 0,
    state: 'prepared',
  };
}
export function claim(
  value: UserOperationRecord,
  now: number,
  signature: Hex = '0x1234',
): UserOperationClaim {
  const operation = { ...value.operation, signature };
  return {
    actor: value.actor,
    id: value.id,
    key: `submit:${value.id}`,
    operation,
    signedCommitment: userOperationCommitment(operation, value.entryPoint, value.chainId),
    authorization: { issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 60 },
    now,
  };
}
