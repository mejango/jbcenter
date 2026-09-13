import {createHmac} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {readRestExecutionConfiguration} from '../src/rest/executionConfig.js';
import {UserOperationSponsorRoutes} from '../src/rest/userOperations/sponsorRoutes.js';

const now=Date.parse('2026-09-12T18:00:00Z');
const key='ab'.repeat(32);
const route={id:'beep',chainId:8453,policyId:'sp_soft_trish_tilby',authorizationKey:key};
const expected={accountId:'eip155:8453:0x1111111111111111111111111111111111111111',planId:'plan-one',chainId:8453,stepIndexes:[0,1],idempotencyKey:'one-preparation'};
function token(change:Record<string,unknown>={},secret=key) {
  const body=Buffer.from(JSON.stringify({...expected,routeId:'beep',issuedAt:now/1000,expiresAt:now/1000+300,...change})).toString('base64url');
  return `${body}.${createHmac('sha256',Buffer.from(secret,'hex')).update(body).digest('hex')}`;
}
async function setup() {
  const execution=await readRestExecutionConfiguration(JSON.stringify({chains:[{
    chainId:8453,bundlerUrl:'https://api.pimlico.io/v2/8453/rpc?apikey=private',paymasterUrl:'https://api.pimlico.io/v2/8453/rpc?apikey=private',paymasterPolicyId:'sp_wide_mastermind',
    gas:{maximumCallGas:'1000000',maximumVerificationGas:'1000000',maximumPreVerificationGas:'100000',maximumPaymasterVerificationGas:'1000000',maximumPaymasterPostOpGas:'0',maximumFeePerGas:'3000000000',maximumPriorityFeePerGas:'1000000000',maximumCost:'10000000000000000'},
  }]}));
  return {execution,routes:new UserOperationSponsorRoutes(execution.providers,JSON.stringify([route]),()=>now)};
}
describe('server-authorized sponsor routing',()=>{
  it('selects Beep without modifying the shared policy or exposing a second provider key',async()=>{
    const {execution,routes}=await setup();
    const selected=routes.authorize(token(),expected).configuration(8453);
    expect(selected.paymasterPolicy?.context).toEqual({sponsorshipPolicyId:route.policyId});
    expect(execution.providers[0]?.paymasterPolicy?.context).toEqual({sponsorshipPolicyId:'sp_wide_mastermind'});
    expect(selected.bundlerUrl).toBe(execution.providers[0]?.bundlerUrl);
    expect(routes.stored(selected.providerId).configuration(8453).providerId).toBe(selected.providerId);
  });
  it('rejects cross-owner, plan, chain, step and idempotency-key replay and invalid signatures',async()=>{
    const {routes}=await setup();
    for(const change of [{accountId:'other'},{planId:'other'},{chainId:1},{stepIndexes:[1,0]},{stepIndexes:[0]},{idempotencyKey:'another'},{routeId:'other'},{expiresAt:now/1000},{issuedAt:now/1000+1},{expiresAt:now/1000+301},{extra:true}])expect(()=>routes.authorize(token(change),expected)).toThrow();
    for(const value of [null,route.policyId,'',token({},'cd'.repeat(32)),token()+'.extra'])expect(()=>routes.authorize(value,expected)).toThrow();
  });
  it('fails closed on revoked routes and policy changes while keeping default providers intact',async()=>{
    const {execution,routes}=await setup();
    const original=routes.authorize(token(),expected).configuration(8453).providerId;
    const changed=new UserOperationSponsorRoutes(execution.providers,JSON.stringify([{...route,policyId:'other'}]),()=>now);
    expect(()=>changed.stored(original)).toThrow();
    expect(()=>new UserOperationSponsorRoutes(execution.providers).stored(original)).toThrow();
    for(const entries of [[route,route],[{...route,chainId:1}],[{...route,authorizationKey:'short'}],[{...route,bundlerUrl:'https://attacker.invalid'}]])expect(()=>new UserOperationSponsorRoutes(execution.providers,JSON.stringify(entries))).toThrow();
  });
});
