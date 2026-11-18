const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const modules=Promise.all(['drive','features','trello'].map(name=>import('../web/'+name+'.mjs')));
const json=(value,status=200)=>new Response(status===204?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function memory(initial={}){const values=new Map(Object.entries(initial));return {get:async key=>structuredClone(values.get(key)),set:async(key,value)=>{values.set(key,structuredClone(value));},delete:async key=>values.delete(key),values};}

test('Web artifact exposes notes, homework and OneDrive while excluding desktop tools',async()=>{
 const dist=path.resolve('dist/cnote-web'),html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
 for(const id of ['web-workspace','trello-tool','drive-tool','web-download-link'])assert(html.includes('id="'+id+'"'),id);
 assert(html.includes('>作业</option>'));assert(html.includes('>OneDrive</option>'));
 for(const id of ['tool-ace-source','tool-worker-source','csv-tool','diff-tool','text-tool'])assert(!html.includes('id="'+id+'"'),id);
 assert.deepEqual([...fs.readFileSync(path.join(dist,'pkg/cnote_web_bg.wasm')).subarray(0,4)],[0,97,115,109]);
});
test('OneDrive pagination and preauthenticated content never forward an OAuth token to storage',async()=>{
 const [{createDrive}]=await modules;const calls=[];
 const drive=createDrive({graph:async url=>{calls.push(url);if(url.includes('/children'))return json({value:[{id:'one'}],'@odata.nextLink':'https://graph.microsoft.com/v1.0/next'});if(url.endsWith('/next'))return json({value:[{id:'two'}]});return json({id:'file',name:'文章.txt',eTag:'v1',folder:{},'@microsoft.graph.downloadUrl':'https://storage.example/document'});},fetch:async(url,options)=>{assert.equal(url,'https://storage.example/document');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);return new Response('正文');},downloads:{}});
 assert.equal((await drive.request({op:'list'})).items.length,2);
 const result=await drive.request({op:'read',id:'file'});assert.equal(result.text,'正文');assert.equal(result.item.eTag,'v1');
 assert(calls.includes('/me/drive/items/file'));
 assert(!calls.some(url=>url.includes('@microsoft.graph.downloadUrl')||url.endsWith('/content')));
});
test('OneDrive writes retain ETag guards and reject unsafe names before requests',async()=>{
 const [{createDrive}]=await modules;const calls=[];
 const drive=createDrive({graph:async(url,options)=>{calls.push({url,options});return json({},412);},downloads:{}});
 await assert.rejects(drive.request({op:'rename',id:'file',etag:'old',name:'new.txt'}),/已变化/);
 assert.equal(calls[0].options.headers['If-Match'],'old');assert.equal(calls.length,1);
 await assert.rejects(drive.request({op:'mkdir',name:'../escape'}),/文件名无效/);assert.equal(calls.length,1);
});
test('OneDrive recursive downloads keep folders and produce one archive',async()=>{
 const [{createDrive}]=await modules;let archive;
 const drive=createDrive({graph:async url=>url.includes('/children')?json({value:[{id:'child',name:'语文.txt',file:{}}]}):json({id:'folder',name:'作业',folder:{},'@microsoft.graph.downloadUrl':'https://storage.example/file'}),fetch:async()=>new Response('contents'),downloads:{zip(name,files){archive={name,files};}}});
 await drive.request({op:'download',ids:['folder']});assert.equal(archive.name,'CNote-OneDrive.zip');assert.equal(new TextDecoder().decode(archive.files['作业/语文.txt']),'contents');
});
test('workspace switching restores the homework workspace and remembered board',async()=>{
 const [,{createFeatures}]=await modules,store=memory({tools:{workspace:4,trelloBoard:'previous-board'}}),nodes=new Map(),classes=new Set(),shown=[];
 const oldWindow=global.window,oldDocument=global.document,oldLocation=global.location;
 global.document={body:{classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}},getElementById(id){if(!nodes.has(id))nodes.set(id,{hidden:true,value:'',textContent:''});return nodes.get(id);}};
 global.window={cnoteTrello:{show(){shown.push(window.cnoteTools.state.trelloBoard);},hide(){}},cnoteDrive:{show(){shown.push(5);},account(){}}};global.location={origin:'https://app.example'};
 try{const features=await createFeatures({store,graph:()=>{},fetch:()=>{},storage:{getItem:()=>null},compareNote:()=>{},onShow(){},getAccount:()=>null});features.show(features.initialWorkspace);assert.equal(features.initialWorkspace,4);assert(classes.has('web-tools'));features.show(5);assert.deepEqual(shown,['previous-board',5]);assert(classes.has('web-tools'));features.show(0);assert(!classes.has('web-tools'));await window.cnoteTools.flush();assert.equal((await store.get('tools')).workspace,0);}
 finally{global.window=oldWindow;global.document=oldDocument;global.location=oldLocation;}
});

test('homework uses Trello directly and only reads card and attachment metadata', async () => {
 const [,,{createTrello,trelloAuthorization}] = await modules;
 const key = 'a'.repeat(32), token = 'b'.repeat(64), id = 'c'.repeat(24);
 const authorization = new URL(trelloAuthorization(key));
 assert.equal(authorization.origin, 'https://trello.com');
 assert.equal(authorization.searchParams.get('scope'), 'read,write');

 const calls = [];
 const session = new Map();
 const storage = {getItem: k => session.get(k), setItem: (k,v) => session.set(k,v), removeItem: k => session.delete(k)};
 const fetch = async (url, options) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://api.trello.com');
  assert(!parsed.searchParams.has('token'));
  assert.equal(options.headers.Authorization, `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`);
  assert.equal(options.method, undefined);
  calls.push(parsed.pathname);
  return json(parsed.pathname.endsWith('/attachments') ? [{name:'朗读.m4a'}] : []);
 };
 const client = createTrello({fetch,storage});
 await client.request({op:'connect',key,token});
 const resumed = createTrello({fetch,storage});
 assert.equal((await resumed.request({op:'status'})).connected,true);
 await resumed.request({op:'boards'});
 await resumed.request({op:'board',id});
 assert.deepEqual((await resumed.request({op:'card',id})).attachments,[{name:'朗读.m4a'}]);
 await assert.rejects(resumed.request({op:'update_cell',id}), /仅支持查看/);
 await assert.rejects(resumed.request({op:'download_homework_attachment',id}), /仅支持查看/);
 assert.deepEqual(calls.sort(), [
  '/1/members/me','/1/members/me/boards',`/1/boards/${id}/lists`,`/1/boards/${id}/cards`,
  `/1/cards/${id}`,`/1/cards/${id}/attachments`,`/1/cards/${id}/actions`,
 ].sort());
 await resumed.request({op:'disconnect'});
 assert.equal((await createTrello({fetch,storage}).request({op:'status'})).connected,false);
});
