import {createHmac} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {readRestExecutionConfiguration} from '../src/rest/executionConfig.js';
import {UserOperationSponsorRoutes,sponsoredCallsCommitment} from '../src/rest/userOperations/sponsorRoutes.js';

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
  it('accepts a voucher bound to the calls and manifest instead of a plan, and refuses a plan whose calls, manifest or step coverage differ',async()=>{
    const {routes}=await setup();
    const calls=[{chainId:8453,to:'0x'+'aa'.repeat(20),data:'0x1234',value:'0'},{chainId:8453,to:'0x'+'bb'.repeat(20),data:'0xabcd',value:'0'}];
    const manifestRevision='0x'+'cc'.repeat(32);
    const bound={accountId:expected.accountId,chainId:8453,manifestRevision,callsCommitment:sponsoredCallsCommitment(calls),idempotencyKey:expected.idempotencyKey};
    const voucher=(change:Record<string,unknown>={})=>{
      const body=Buffer.from(JSON.stringify({...bound,routeId:'beep',issuedAt:now/1000,expiresAt:now/1000+300,...change})).toString('base64url');
      return `${body}.${createHmac('sha256',Buffer.from(key,'hex')).update(body).digest('hex')}`;
    };
    const plan={id:'plan-two',calls,manifestRevision,stepIndexes:[0,1]};
    expect(routes.authorize(voucher(),{...expected,planId:'plan-two',stepIndexes:[0,1],manifestRevision,calls}).configuration(8453).paymasterPolicy?.context).toEqual({sponsorshipPolicyId:route.policyId});
    // The commitment is over the exact calls in order, whatever the plan's id; case in hex does not matter, content does.
    expect(()=>routes.authorize(voucher(),{...expected,planId:'another-plan',stepIndexes:[0,1],manifestRevision,calls:calls.map(c=>({...c,to:c.to.toUpperCase().replace('0X','0x')}))})).not.toThrow();
    for(const change of [
      {calls:[calls[1]!,calls[0]!]},{calls:[calls[0]!]},{calls:[{...calls[0]!,value:'1'},calls[1]!]},{calls:[{...calls[0]!,data:'0x12345'},calls[1]!]},
      {manifestRevision:'0x'+'dd'.repeat(32)},{stepIndexes:[0]},{stepIndexes:[1,0]},{accountId:'other'},{idempotencyKey:'other'},
    ])expect(()=>routes.authorize(voucher(),{...expected,planId:plan.id,stepIndexes:plan.stepIndexes,manifestRevision,calls,...change})).toThrow();
    for(const change of [{planId:'plan-two'},{callsCommitment:'0x'+'00'.repeat(32)},{manifestRevision:'0x'+'dd'.repeat(32)},{extra:1}])expect(()=>routes.authorize(voucher(change),{...expected,planId:plan.id,stepIndexes:[0,1],manifestRevision,calls})).toThrow();
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
