/** Only for failures from a native passkey prompt; HTTP failures retain their recovery path. */
export function nativePasskeyError(error: unknown, aborted = false): { message: string; state: 'ready' | 'error' } {
  const name = error instanceof DOMException ? error.name : '', detail = error instanceof DOMException && error.message ? `: ${error.message}` : '';
  if (name === 'AbortError' || (name === 'NotAllowedError' && aborted)) return { message: 'Passkey prompt cancelled. You can try again.', state: 'error' };
  return { message: `The passkey prompt did not complete (${name}${detail}). If your passkey manager just saved this passkey, wait a moment and try again.`, state: 'error' };
}
