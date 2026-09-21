import { keccak256, stringToHex, type Hex } from "viem";

export type SponsoredCall = { chainId: number; to: string; data: string; value: string };
/** What a sponsorship voucher commits a payment to: the ordered calls, hex lowercased and the value
 * in decimal, as an array of arrays so no key order can disagree between the issuer and Center.
 * The issuer (an app such as Beep) imports this from the wallet client package rather than
 * re-implementing it; a drift here would refuse every sponsored payment. */
export function sponsoredCallsCommitment(calls: readonly SponsoredCall[]): Hex {
  return keccak256(stringToHex(JSON.stringify(calls.map((call) => [call.chainId, call.to.toLowerCase(), call.data.toLowerCase(), BigInt(call.value).toString()]))));
}
