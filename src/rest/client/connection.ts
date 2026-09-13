import { isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseAccountId } from "../auth/signatures.js";
import { isCanonicalGrantScopes, type BotScope, type BotGrant } from "../auth/store.js";
import { clientAudience, RestClientError } from "./index.js";

/** Local secret. Never send this document to Center or put it in a URL. */
export interface BotConnection {
  format: "juicebox-center-connection-v1";
  audience: string;
  accountId: string;
  grantId: string;
  botAddress: Address;
  privateKey: Hex;
  scopes: BotScope[];
  expiresAt: number;
}
export function parseConnection(value: unknown): BotConnection {
  const invalid = (): never => { throw new RestClientError("INVALID_CONNECTION", "Choose the connection file downloaded after registering your bot."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["format", "audience", "accountId", "grantId", "botAddress", "privateKey", "scopes", "expiresAt"].includes(key)) ||
      v.format !== "juicebox-center-connection-v1" || typeof v.audience !== "string" ||
      typeof v.accountId !== "string" || typeof v.grantId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.grantId) ||
      typeof v.botAddress !== "string" || !isAddress(v.botAddress) ||
      typeof v.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.privateKey) ||
      !isCanonicalGrantScopes(v.scopes) || !Number.isSafeInteger(v.expiresAt) || Number(v.expiresAt) < 1) return invalid();
  try {
    clientAudience(v.audience); parseAccountId(v.accountId);
    if (privateKeyToAccount(v.privateKey as Hex).address.toLowerCase() !== v.botAddress.toLowerCase()) return invalid();
  } catch { return invalid(); }
  return { format: "juicebox-center-connection-v1", audience: v.audience, accountId: v.accountId,
    grantId: v.grantId, botAddress: v.botAddress as Address, privateKey: v.privateKey as Hex,
    scopes: [...v.scopes], expiresAt: Number(v.expiresAt) };
}
export function connectionForBot(audience: string, bot: BotGrant, privateKey: Hex): BotConnection {
  if (bot.revokedAt !== null) throw new RestClientError("REVOKED_CONNECTION", "This bot grant has been revoked.");
  return parseConnection({ format: "juicebox-center-connection-v1", audience, accountId: bot.accountId,
    grantId: bot.id, botAddress: bot.botAddress, privateKey, scopes: bot.scopes, expiresAt: bot.expiresAt });
}
