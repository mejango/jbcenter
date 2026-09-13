import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {RestError} from '../core.js';
import {UserOperationProvider, createPimlicoV7PaymasterPolicy, createPimlicoCurrentV7PaymasterPolicy} from './provider.js';
import type {UserOperationProviderConfig} from './types.js';

type Authorization = {routeId:string; accountId:string; planId:string; chainId:number; stepIndexes:number[]; idempotencyKey:string; issuedAt:number; expiresAt:number};
type Route = {id:string; chainId:number; policyId:string; authorizationKey:string};
function reject():never {throw new RestError(403,'SPONSOR_AUTHORIZATION_INVALID','The sponsorship authorization is invalid or expired.');};
function invalid():never {throw new RestError(500,'SPONSOR_ROUTES_INVALID','Sponsorship routes require unique IDs, reviewed providers and private authorization keys.');};

/** Server-issued vouchers select a separately budgeted policy. The owner must still
 * sign Center requests and each operation. Provider credentials never leave Center.
 * Vouchers bind one preparation key, owner, immutable plan and exact ordered steps.
 */
export class UserOperationSponsorRoutes {
  private readonly routes = new Map<string,{route:Route;provider:UserOperationProvider;providerId:string}>();
  constructor(configurations:readonly UserOperationProviderConfig[], raw?:string, private readonly now=Date.now) {
    if(raw===undefined)return;
    if(raw.length>32768)invalid();
    let entries:unknown;
    try {entries=JSON.parse(raw);} catch {invalid();}
    if(!Array.isArray(entries)||entries.length>16)invalid();
    for(const entry of entries as Route[]) {
      if(!entry||typeof entry!=='object'||Object.keys(entry).sort().join(',')!=='authorizationKey,chainId,id,policyId'||
        typeof entry.id!=='string'||!/^[a-z0-9-]{1,32}$/.test(entry.id)||this.routes.has(entry.id)||
        typeof entry.policyId!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(entry.policyId)||
        typeof entry.authorizationKey!=='string'||!/^[a-f0-9]{64}$/.test(entry.authorizationKey))invalid();
      const base=configurations.find(config=>config.chainId===entry.chainId);
      if(!base?.paymasterPolicy||!base.paymasterUrl)invalid();
      const create=base.paymasterPolicy.profile==='pimlico-v7-current-flags'?createPimlicoCurrentV7PaymasterPolicy:createPimlicoV7PaymasterPolicy;
      const providerId=`sponsor-${entry.chainId}-${entry.id}-${createHash('sha256').update(entry.policyId).digest('hex').slice(0,16)}`;
      if(configurations.some(config=>config.providerId===providerId))invalid();
      const paymasterPolicy=create({chainId:entry.chainId,policyId:entry.policyId,context:{sponsorshipPolicyId:entry.policyId}});
      const provider=new UserOperationProvider([{...base,providerId,paymasterPolicy}]);
      this.routes.set(entry.id,{route:entry,provider,providerId});
    }
  }
  authorize(token:unknown, expected:Omit<Authorization,'routeId'|'issuedAt'|'expiresAt'>):UserOperationProvider {
    if(typeof token!=='string'||token.length>4096)reject();
    const parts=token.split('.');
    if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0]!)||!/^[a-f0-9]{64}$/.test(parts[1]!))reject();
    let value:Authorization;
    try {value=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));} catch {return reject();}
    if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='accountId,chainId,expiresAt,idempotencyKey,issuedAt,planId,routeId,stepIndexes')reject();
    const selected=this.routes.get(value.routeId);
    if(!selected)reject();
    const digest=createHmac('sha256',Buffer.from(selected.route.authorizationKey,'hex')).update(parts[0]!).digest();
    if(!timingSafeEqual(digest,Buffer.from(parts[1]!,'hex')))reject();
    const now=Math.floor(this.now()/1000);
    if(!Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(value.expiresAt)||value.issuedAt>now||value.expiresAt<=now||value.expiresAt-value.issuedAt>300||value.expiresAt<=value.issuedAt||
      value.accountId!==expected.accountId||value.planId!==expected.planId||value.chainId!==expected.chainId||value.chainId!==selected.route.chainId||value.idempotencyKey!==expected.idempotencyKey||
      !Array.isArray(value.stepIndexes)||JSON.stringify(value.stepIndexes)!==JSON.stringify(expected.stepIndexes))reject();
    return selected.provider;
  }
  stored(providerId:string):UserOperationProvider {
    const selected=[...this.routes.values()].find(route=>route.providerId===providerId);
    if(!selected)throw new RestError(409,'SPONSOR_ROUTE_UNAVAILABLE','The stored sponsorship route is no longer configured.');
    return selected.provider;
  }
}
