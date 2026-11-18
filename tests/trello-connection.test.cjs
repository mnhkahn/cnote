const {test}=require('node:test'),assert=require('node:assert/strict');
const modules=Promise.all([import('../web/trello.mjs'),import('../web/connection.mjs')]);
const key='a'.repeat(32),token='b'.repeat(64),member='c'.repeat(24),board='d'.repeat(24);
const record={credentials:{key,token},member_id:member,member_name:'家长',board_id:board,board_name:'嘉嘉'};
function session(){const map=new Map();return {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map};}
function broker(){const rows=new Map(),calls=[];let revision=0,fail=false;
 return {rows,calls,setFail(value){fail=value;},forUser(user){return async(method,expected='',value)=>{
 calls.push({user,method});if(fail)throw Error('同步服务暂不可用');const old=rows.get(user);
 if(method==='GET')return structuredClone(old||{connected:false});
 if(expected!==(old?.revision||''))throw Object.assign(Error('作业连接已在其他设备更新'),{code:'connection_changed'});
 if(method==='DELETE'){rows.delete(user);return {connected:false};}
 const saved={connected:true,revision:'v'+(++revision),connection:structuredClone(value)};rows.set(user,saved);return structuredClone(saved);
 };}};
}
function trelloFetch(calls){return async(url,options)=>{
 const path=new URL(url).pathname;calls.push(path);assert.equal(options.headers.Authorization,`OAuth oauth_consumer_key="${key}", oauth_token="${token}"`);
 let data=path.endsWith('/members/me')?{id:member,fullName:'家长'}:path.endsWith('/members/me/boards')?[{id:board,name:'嘉嘉',closed:false}]:path.endsWith('/boards/'+board)?{id:board,name:'嘉嘉',closed:false}:[];
 return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};}
test('fresh second device restores authorization and board after Microsoft login only',async()=>{
 const [{createTrello}]=await modules,server=broker(),calls=[],account={homeAccountId:'microsoft-a',name:'微软家长'};
 const first=createTrello({fetch:trelloFetch(calls),storage:session(),getAccount:()=>account,connection:server.forUser('microsoft-a')});
 await first.request({op:'connect',key,token});assert.equal((await first.request({op:'status',account_id:account.homeAccountId})).linked,false);
 await first.request({op:'link_account',id:board,member_id:member,account_id:account.homeAccountId});
 const secondCalls=[],secondStorage=session(),second=createTrello({fetch:trelloFetch(secondCalls),storage:secondStorage,getAccount:()=>account,connection:server.forUser('microsoft-a')});
 const restored=await second.request({op:'status',account_id:account.homeAccountId});assert.equal(restored.linked,true);assert.equal(restored.board,board);assert.equal(restored.connected,true);
 await second.request({op:'boards'});assert.deepEqual(secondCalls,['/1/members/me/boards']);assert.equal(secondStorage.map.size,0,'restored cloud token stays in memory, outside browser storage');
 await first.request({op:'disconnect'});assert.equal((await second.request({op:'status'})).connected,false);
});
test('another Microsoft account cannot inherit a restored connection',async()=>{
 const [{createTrello}]=await modules,server=broker();server.rows.set('microsoft-a',{connected:true,revision:'v1',connection:record});let account={homeAccountId:'microsoft-a'};
 const client=createTrello({fetch:trelloFetch([]),storage:session(),getAccount:()=>account,connection:(...args)=>server.forUser(account.homeAccountId)(...args)});
 assert.equal((await client.request({op:'status'})).connected,true);account={homeAccountId:'microsoft-b'};
 assert.equal((await client.request({op:'status'})).connected,false);await assert.rejects(client.request({op:'boards'}),/关联 Trello/);
});
test('service failure preserves usable local authorization without inventing a cloud association',async()=>{
 const [{createTrello}]=await modules,server=broker(),account={homeAccountId:'microsoft-a'};server.setFail(true);
 const client=createTrello({fetch:trelloFetch([]),storage:session(),getAccount:()=>account,connection:server.forUser('microsoft-a')});await client.request({op:'connect',key,token});
 const status=await client.request({op:'status'});assert.equal(status.connected,true);assert.equal(status.cloud_available,false);assert.notEqual(status.linked,true);await client.request({op:'boards'});
});
test('connection transport sends credentials only to the fixed service and keeps revision guards',async()=>{
 const [,{createConnection}]=await modules,calls=[];
 const connection=createConnection({getAccessToken:async()=>'microsoft-token',fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({connected:true,revision:'v2',connection:record}));}});
 await connection('PUT','',record);await connection('PUT','v1',record);await connection('DELETE','v2');
 for(const {url,options}of calls){assert.equal(url,'/api/cnote/trello-connection');assert.equal(options.headers.Authorization,'Bearer microsoft-token');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.credentials,'omit');}
 assert.equal(calls[0].options.headers['If-None-Match'],'*');assert.equal(calls[1].options.headers['If-Match'],'"v1"');assert.equal(calls[2].options.headers['If-Match'],'"v2"');
});
test('connection errors do not echo upstream bodies or secrets',async()=>{
 const [,{createConnection}]=await modules;
 const connection=createConnection({getAccessToken:async()=>'token',fetch:async()=>new Response(JSON.stringify({code:'unknown',error:'private token='+token}),{status:500})});
 await assert.rejects(connection(),error=>!error.message.includes(token)&&/暂不可用/.test(error.message));
});
test('new Trello authorization is kept until confirmation instead of being overwritten by old cloud credentials',async()=>{
 const [{createTrello}]=await modules,server=broker(),account={homeAccountId:'microsoft-a'},newToken='e'.repeat(64),headers=[];
 server.rows.set('microsoft-a',{connected:true,revision:'v1',connection:record});
 const client=createTrello({storage:session(),getAccount:()=>account,connection:server.forUser('microsoft-a'),fetch:async(url,options)=>{
  headers.push(options.headers.Authorization);const path=new URL(url).pathname;
  return new Response(JSON.stringify(path.endsWith('/members/me')?{id:member,fullName:'家长'}:path.endsWith('/boards/'+board)?{id:board,name:'嘉嘉',closed:false}:[]));
 }});
 await client.request({op:'status'});await client.request({op:'connect',key,token:newToken});
 assert.equal((await client.request({op:'status'})).linked,false);
 await client.request({op:'link_account',id:board,member_id:member});
 assert.equal(server.rows.get('microsoft-a').connection.credentials.token,newToken);
 assert(headers.every(value=>value.includes(newToken)));
});
