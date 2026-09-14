import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WalletAuthorityCredential } from "../src/rest/wallet/authority.js";
import { createWalletLoginDraft, copyWalletLoginCompletion, deriveWalletCentralSessionToken, validateWalletLoginDraft,
  walletCentralSessionTokenHash, walletLoginChallenge, walletLoginFlowTokenHash, verifyWalletLoginProof } from "../src/rest/wallet/login.js";
import { createRegistration, signGet } from "./fixtures/wallet-enrollment-crypto.js";
const rpId="juicebox.center", origin="https://juicebox.center", nowMs=1_800_000_120_123;
function fixture() {
  const {draft,flowToken}=createWalletLoginDraft({rpId,origin,nowMs});
  const challenge=walletLoginChallenge(draft).challenge;
  const registration=createRegistration({rpId,origin,challenge,userHandle:randomBytes(32).toString("base64url")});
  const credential:WalletAuthorityCredential={accountId:`eip155:8453:0x${"12".repeat(20)}`,enrollmentId:randomUUID(),rpId,
    credentialId:registration.credentialId,userHandle:registration.userHandle,publicKey:registration.publicKey,
    backupEligible:true,verifiedAtMs:nowMs-1000,supersededAtMs:null};
  const assertion=signGet({...registration,rpId,origin,challenge});
  return {draft,flowToken,challenge,registration,credential,assertion};
}
describe("discoverable wallet login pure boundary",()=>{
  it("issues independent bounded anonymous challenges and only persists a flow hash",()=>{
    const a=fixture(),b=fixture();
    expect(a.draft.ceremony.accountId).toBe(`wallet-login:${a.draft.id}`);
    expect(a.draft.ceremony.purpose).toBe("login");
    expect(a.draft.expiresAtMs).toBeLessThanOrEqual(nowMs+180_000);
    expect(a.draft.expiresAtMs%1000).toBe(0);
    expect(a.draft.retainUntilMs).toBe(a.draft.expiresAtMs+3_600_000+86_400_000);
    expect(JSON.stringify(a.draft)).not.toContain(a.flowToken);
    expect(a.draft.flowTokenHash).toBe(walletLoginFlowTokenHash(a.flowToken));
    expect(a.challenge).not.toBe(b.challenge);
    expect(validateWalletLoginDraft(a.draft)).toEqual(a.draft);
  });
  it("domain separates a recoverable session secret and hashes it independently",()=>{
    const {draft,flowToken}=fixture(),token=deriveWalletCentralSessionToken(flowToken,draft.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveWalletCentralSessionToken(flowToken,draft.id)).toBe(token);
    expect(deriveWalletCentralSessionToken(flowToken,randomUUID())).not.toBe(token);
    expect(deriveWalletCentralSessionToken(randomBytes(32).toString("base64url"),draft.id)).not.toBe(token);
    expect(walletLoginFlowTokenHash(token)).not.toBe(walletCentralSessionTokenHash(token));
  });
  it("requires real UV P256 possession with exact discoverable user handle",()=>{
    const f=fixture();
    const result=verifyWalletLoginProof(f.draft,f.flowToken,f.credential,f.assertion);
    expect(result).toMatchObject({credentialId:f.credential.credentialId,userHandle:f.credential.userHandle,signCount:0,backupEligible:true});
    expect(()=>verifyWalletLoginProof(f.draft,f.flowToken,f.credential,{...f.assertion,userHandle:null})).toThrow();
    const noUv={...f.assertion,authenticatorData:Buffer.from(f.assertion.authenticatorData)};
    noUv.authenticatorData[32]! &= ~4;
    expect(()=>verifyWalletLoginProof(f.draft,f.flowToken,f.credential,noUv)).toThrow();
    expect(()=>verifyWalletLoginProof(f.draft,randomBytes(32).toString("base64url"),f.credential,f.assertion)).toThrow();
    expect(()=>verifyWalletLoginProof(f.draft,f.flowToken,{...f.credential,backupEligible:false},f.assertion)).toThrow();
  });
  it("rejects a validly encoded assertion signed by a different P256 key",()=>{
    const f=fixture(), other=fixture();
    const forged=signGet({...f.registration,key:other.registration.key,rpId,origin,challenge:f.challenge});
    expect(()=>verifyWalletLoginProof(f.draft,f.flowToken,f.credential,forged)).toThrow();
  });
  it("rejects noncanonical or incorrectly sized bearer secrets",()=>{
    const f=fixture();
    for(const token of [f.flowToken+"=",randomBytes(31).toString("base64url"),randomBytes(33).toString("base64url")," "+f.flowToken]) {
      expect(()=>walletLoginFlowTokenHash(token)).toThrow();
      expect(()=>walletCentralSessionTokenHash(token)).toThrow();
      expect(()=>deriveWalletCentralSessionToken(token,f.draft.id)).toThrow();
    }
  });
  it("rejects non-scalar credential identity without invoking coercion",()=>{
    const f=fixture();let calls=0;
    const credential={...f.credential,accountId:{toString(){calls++;return f.credential.accountId;}}};
    expect(()=>verifyWalletLoginProof(f.draft,f.flowToken,credential as any,f.assertion)).toThrow();expect(calls).toBe(0);
  });
  it("semantic proof stays stable across fresh authenticator signatures, counters and backup state",()=>{
    const f=fixture();
    const again=signGet({...f.registration,rpId,origin,challenge:f.challenge,signCount:42,backedUp:false});
    const a=verifyWalletLoginProof(f.draft,f.flowToken,f.credential,f.assertion);
    const b=verifyWalletLoginProof(f.draft,f.flowToken,f.credential,again);
    expect(a.verificationDigest).toBe(b.verificationDigest);
    expect(b.signCount).toBe(42); expect(b.backedUp).toBe(false);
    expect(()=>verifyWalletLoginProof(fixture().draft,f.flowToken,f.credential,again)).toThrow();
  });
  it.each([0,999,180001,NaN,Infinity])("rejects unsupported lifetime %s",lifetimeMs=>{
    expect(()=>createWalletLoginDraft({rpId,origin,nowMs,lifetimeMs})).toThrow();
  });
  it.each(["https://evil.example","https://juicebox.center/path","http://juicebox.center"])("rejects mismatched RP/origin %s",bad=>{
    expect(()=>createWalletLoginDraft({rpId,origin:bad,nowMs})).toThrow();
  });
  it("rejects changed intent fields, account alias, nonce, retention and expiry",()=>{
    const f=fixture();
    for(const changed of [{...f.draft,sessionId:randomUUID()},{...f.draft,origin:"https://evil.example"},
      {...f.draft,expiresAtMs:f.draft.expiresAtMs+1000},{...f.draft,retainUntilMs:f.draft.retainUntilMs+1},
      {...f.draft,ceremony:{...f.draft.ceremony,accountId:f.credential.accountId}},
      {...f.draft,ceremony:{...f.draft.ceremony,contextDigest:"00".repeat(32)}}])
      expect(()=>validateWalletLoginDraft(changed)).toThrow();
  });
  it("copies bounded assertion bytes before async work without invoking caller iterators",()=>{
    const f=fixture();let calls=0;
    Object.defineProperty(f.assertion.authenticatorData,Symbol.iterator,{value:()=>{calls++;throw Error("trap");}});
    Object.defineProperty(f.assertion.authenticatorData,"byteLength",{get:()=>{calls++;throw Error("trap");}});
    const result=copyWalletLoginCompletion({loginId:f.draft.id,flowToken:f.flowToken,assertion:f.assertion});
    expect(calls).toBe(0);
    f.assertion.authenticatorData[0]=f.assertion.authenticatorData[0]!^255;
    expect(result.assertion.authenticatorData[0]).not.toBe(f.assertion.authenticatorData[0]);
  });
  it("rejects proxy and accessor request fields without executing traps",()=>{
    const f=fixture();let calls=0;
    const input={loginId:f.draft.id,flowToken:f.flowToken,assertion:f.assertion};
    const proxy=new Proxy(input,{getPrototypeOf(){calls++;throw Error("trap");}});
    expect(()=>copyWalletLoginCompletion(proxy)).toThrow();
    const accessor=Object.defineProperty({...input},"flowToken",{get(){calls++;return f.flowToken;}});
    expect(()=>copyWalletLoginCompletion(accessor)).toThrow();expect(calls).toBe(0);
  });
});
