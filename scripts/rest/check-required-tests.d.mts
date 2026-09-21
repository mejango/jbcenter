export function captureSourceSnapshot(projectRoot: string, gitEnv?: NodeJS.ProcessEnv, gitBinary?: string): Promise<{
  revision: string; dirty: boolean; fingerprint: string;
}>;
