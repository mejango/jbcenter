import { userInfo } from 'node:os';
import { join } from 'node:path';
import { captureSourceSnapshot } from './check-required-tests.mjs';

/** Shared by every checkout, outside temporary and cloud-synced document directories. */
export function walletDependencyJournalDirectory() {
  return join(userInfo().homedir, '.juicebox-center', 'wallet-dependencies');
}
/** Source inspection subprocesses must never receive provider or signing secrets. */
export function walletOperatorGitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
export function walletOperatorSource(root: string) {
  return captureSourceSnapshot(root, walletOperatorGitEnvironment(), '/usr/bin/git');
}
export function takeWalletDependencySecrets(environment: NodeJS.ProcessEnv = process.env) {
  const fundingKey = environment.CENTER_WALLET_DEPLOYMENT_FUNDING_PRIVATE_KEY, dwellirKey = environment.DWELLIR_API_KEY;
  delete environment.CENTER_WALLET_DEPLOYMENT_FUNDING_PRIVATE_KEY;
  delete environment.DWELLIR_API_KEY;
  return { fundingKey, dwellirKey };
}
