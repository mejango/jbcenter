import { MAX_PROJECT_LOGO_BYTES } from '../services/metadata.js';

export const MAX_BODY_BYTES = 256 * 1024;
// A complete base64 logo plus its bounded JSON-RPC envelope.
export const MAX_LOGO_REQUEST_BYTES = Math.ceil(MAX_PROJECT_LOGO_BYTES / 3) * 4 + 4096;
