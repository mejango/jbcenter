import {describe,it,expect,vi} from "vitest";
import type {Pool} from "pg";
import {keccak256,stringToHex,padHex,type Address,type Hex} from "viem";
import {FactoryHistoryIndex,type FactoryHistorySeed} from "../src/rest/smartAccounts/factoryHistory.js";
const factory=`0x${"11".repeat(20)}` as Address,proxy=`0x${"22".repeat(20)}` as Address;
const hash=(n:bigint|number)=>`0x${BigInt(n).toString(16).padStart(64,"0")}` as Hex;
const topic=keccak256(stringToHex("ProxyCreation(address,address)"));
const event=(block:number,account=proxy)=>({address:factory,topics:[topic,padHex(account,{size:32})],data:hash(1),removed:false,blockNumber:`0x${block.toString(16)}`,blockHash:hash(block),transactionHash:hash(block+10000),logIndex:"0x0"});
function fixture(creations:FactoryHistorySeed['creations']=[[proxy,42]],account=proxy){
 let state:{through_block:string;block_hash:string}|undefined;
 let events:{block_number:string;proxy:string}[]=[],saved:any;
 const query=vi.fn(async(sql:string,args:any[]=[])=>{
   if(sql==='BEGIN'){saved={state:state&&{...state},events:[...events]};return {rows:[]};}
   if(sql==='ROLLBACK'){if(saved){state=saved.state;events=saved.events;}return {rows:[]};}
   if(sql==='COMMIT'){saved=undefined;return {rows:[]};}
   if(sql.includes('pg_try_advisory'))return {rows:[{locked:true}]};
   if(sql.startsWith('SELECT through_block'))return {rows:state?[state]:[]};
   if(sql.startsWith('INSERT INTO rest_factory_history')){state={through_block:args[2],block_hash:args[3]};return {rows:[]};}
   if(sql.startsWith('INSERT INTO rest_factory_creations')){events.push(...args[2].map((proxy:string,i:number)=>({proxy,block_number:args[3][i]})));return {rows:[]};}
   if(sql.startsWith('SELECT block_number'))return {rows:events.filter(e=>e.proxy===args[2]&&BigInt(e.block_number)<=BigInt(args[3])&&BigInt(e.block_number)>BigInt(args[4]))};
   throw Error('Unexpected SQL');
 });
 const pool={query,connect:async()=>({query,release:()=>{}})} as unknown as Pool;
 const data=[event(42,account),event(1200,account),event(1501,account)];let reorg=false,broken=false,omitPrefix=false;
 const request=vi.fn(async(_chain:number,method:string,params:readonly any[])=>{
   if(method==='eth_getBlockByNumber'){const n=params[0]==='finalized'?1499:BigInt(params[0]);return {number:`0x${BigInt(n).toString(16)}`,hash:reorg?hash(9999):hash(n)};}
   if(method==='eth_getLogs'){const f=params[0],from=BigInt(f.fromBlock),to=BigInt(f.toBlock);expect(to-from).toBeLessThan(500n);if(broken&&from>=1000n)throw Error('RPC unavailable');return data.filter(e=>BigInt(e.blockNumber)>=from&&BigInt(e.blockNumber)<=to&&!(omitPrefix&&e.blockNumber==='0x2a'));}
   throw Error('Unexpected RPC');
 });
 const index=new FactoryHistoryIndex(pool,{request},{chainId:8453,factory,through:999,hash:hash(999),creations});
 return {index,request,query,state:()=>state,reorg:()=>{reorg=true;},breakPage:()=>{broken=true;},omit:()=>{omitPrefix=true;}};
}
describe('complete retained factory history',()=>{
 it('joins the complete prefix, durable finalized tail, and current tail using at most 500-block reads',async()=>{
  const f=fixture();const result=await f.index.creationLogs(8453,factory,proxy,1502n);
  expect(result?.map(l=>Number(BigInt(String(l.blockNumber))))).toEqual([42,1200,1501]);
  expect(f.state()?.through_block).toBe('1499');
  expect(f.request.mock.calls.filter(c=>c[1]==='eth_getLogs').every(c=>c[2][0].fromBlock!=='0x0')).toBe(true);
 });
 it('rejects a changed finalized anchor before trusting absence or indexed entries',async()=>{
  const f=fixture();f.reorg();await expect(f.index.creationLogs(8453,factory,proxy,1502n)).rejects.toThrow('changed');expect(f.state()).toBeUndefined();
 });
 it('never advances the watermark over an unavailable page',async()=>{
  const f=fixture();f.breakPage();await expect(f.index.sync()).rejects.toThrow('RPC unavailable');expect(f.state()).toBeUndefined();
 });
 it('rejects a retained creation missing from the canonical block logs',async()=>{
  const f=fixture();f.omit();await expect(f.index.creationLogs(8453,factory,proxy,1502n)).rejects.toThrow('disagrees');
 });
 it('does not apply another chain or factory index',async()=>{
  const f=fixture();expect(await f.index.creationLogs(1,factory,proxy,1502n)).toBeUndefined();expect(f.request).not.toHaveBeenCalled();
 });
 it.each([0,1,2])('finds a retained address at position %s',async(position)=>{
  const creations:FactoryHistorySeed['creations']=[[proxy,42]];
  if(position>0)creations.unshift([`0x${"11".repeat(20)}`,10]);
  if(position>1)creations.unshift([`0x${"00".repeat(20)}`,5]);
  while(creations.length<3)creations.push([`0x${"33".repeat(20)}`,50]);
  const f=fixture(creations);
  expect((await f.index.creationLogs(8453,factory,proxy,999n))?.map(l=>Number(BigInt(String(l.blockNumber))))).toEqual([42]);
 });
 it('compares retained addresses without case sensitivity and honors the requested block',async()=>{
  const mixed=`0x${"aB".repeat(20)}` as Address;
  const f=fixture([[mixed,42]],mixed.toLowerCase() as Address);
  expect(await f.index.creationLogs(8453,factory,mixed.toLowerCase() as Address,41n)).toEqual([]);
  expect((await f.index.creationLogs(8453,factory,mixed.toLowerCase() as Address,999n))?.map(l=>Number(BigInt(String(l.blockNumber))))).toEqual([42]);
 });
 it('returns no retained creation for an absent address',async()=>{
  const f=fixture();
  expect(await f.index.creationLogs(8453,factory,`0x${"33".repeat(20)}`,999n)).toEqual([]);
 });
 it('retains duplicate creation claims so canonical disagreement still fails',async()=>{
  const f=fixture([[proxy,42],[proxy,42]]);
  await expect(f.index.creationLogs(8453,factory,proxy,999n)).rejects.toThrow('disagrees');
 });
 it('rejects an unsorted retained index instead of inferring a missing creation',()=>{
  expect(()=>fixture([[`0x${"33".repeat(20)}`,50],[proxy,42]])).toThrow('sorted');
 });
});
