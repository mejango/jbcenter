// Run only on a trusted operator's completed backfill. Never serve this as an HTTP endpoint.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {gzipSync} from 'node:zlib';
import {keccak256,stringToHex} from 'viem';
const [metaPath,pagesPath,output] = process.argv.slice(2);
if(!metaPath||!pagesPath||!output||!process.env.DWELLIR_API_KEY)throw Error('Provide metadata, completed pages, output directory, and DWELLIR_API_KEY');
const meta=JSON.parse(await readFile(metaPath,'utf8'));
const factory='0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',topic=keccak256(stringToHex('ProxyCreation(address,address)'));
if(meta.chainId!==8453||meta.factory!==factory||meta.topic!==topic||!Number.isSafeInteger(meta.through)||meta.through<0||!/^0x[0-9a-fA-F]{64}$/.test(meta.hash))throw Error('Invalid metadata');
const pages=createInterface({input:createReadStream(pagesPath),crlfDelay:Infinity});
const seen=new Set(),events=new Set(),creations=[];
for await(const line of pages){
 const p=JSON.parse(line);
 if(!Number.isSafeInteger(p.from)||p.from<0||p.from%500!==0||p.from>meta.through||seen.has(p.from)||!Array.isArray(p.logs)||p.logs.length>=10000)throw Error('Invalid, duplicate or incomplete page');
 seen.add(p.from);
 for(const l of p.logs){
  if(l.removed!==false||l.address?.toLowerCase()!==factory.toLowerCase()||l.topics?.length!==2||l.topics[0]!==topic||!/^0x0{24}[0-9a-fA-F]{40}$/.test(l.topics[1])||!/^0x[0-9a-fA-F]{64}$/.test(l.blockHash)||!/^0x[0-9a-fA-F]{64}$/.test(l.transactionHash)||!/^0x[0-9a-f]+$/i.test(l.blockNumber)||!/^0x[0-9a-f]+$/i.test(l.logIndex))throw Error('Malformed creation');
  const block=Number(BigInt(l.blockNumber)),id=l.blockHash+':'+l.logIndex;
  if(block<p.from||block>Math.min(p.from+499,meta.through)||events.has(id))throw Error('Out of range or duplicate creation');
  events.add(id);creations.push(['0x'+l.topics[1].slice(-40).toLowerCase(),block]);
 }
}
for(let from=0;from<=meta.through;from+=500)if(!seen.has(from))throw Error('Missing page '+from);
const response=await fetch('https://api-base-mainnet-archive.n.dwellir.com/'+process.env.DWELLIR_API_KEY,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]},{jsonrpc:'2.0',id:2,method:'eth_getBlockByNumber',params:['0x'+meta.through.toString(16),false]}])});
const result=await response.json();if(!response.ok||!Array.isArray(result)||result.find(r=>r.id===1)?.result!=='0x2105'||result.find(r=>r.id===2)?.result?.hash!==meta.hash)throw Error('Finalized anchor no longer matches');
creations.sort((a,b)=>a[0].localeCompare(b[0])||a[1]-b[1]);
const bytes=JSON.stringify({chainId:8453,factory,through:meta.through,hash:meta.hash,creations})+'\n';
await mkdir(output,{recursive:true});await writeFile(output+'/base.json.gz',gzipSync(bytes));await writeFile(output+'/base.sha256',createHash('sha256').update(bytes).digest('hex')+'\n');
console.log({pages:seen.size,creations:creations.length,through:meta.through,bytes:bytes.length});
