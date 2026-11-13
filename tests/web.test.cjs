const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist/cnote-web');
let server,origin;
before(async()=>{
 assert(fs.existsSync(path.join(dist,'pkg/cnote_web_bg.wasm')),'先运行 npm run build:web');
 server=http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/notes\//,'');
  const file=path.resolve(dist,name||'index.html');
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[path.extname(file)]||'text/plain');res.end(fs.readFileSync(file));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}/notes/`;
});
after(()=>new Promise(resolve=>server.close(resolve)));
test('artifact contains real WASM and only the note page',()=>{
 const bytes=fs.readFileSync(path.join(dist,'pkg/cnote_web_bg.wasm'));assert.deepEqual([...bytes.subarray(0,4)],[0,97,115,109]);
 const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
 for(const banned of ['TOOL_HTML','TOOL_SCRIPT','TRELLO_SCRIPT','tool-ace-source','tool-worker-source','trello-tool','csv-tool','diff-tool','text-tool','Ace Editor'])assert(!html.includes(banned),banned);
 assert(!fs.readFileSync(path.join(dist,'adapter.js'),'utf8').includes('api.trello.com'));
 const sums=fs.readFileSync(path.join(dist,'SHA256SUMS'),'utf8');assert(sums.includes('pkg/cnote_web_bg.wasm'));assert(sums.includes('config.json'));
});
for(const [name,type]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: real WASM notes, persistence, clipboard and tab isolation`,async()=>{
 const browser=await type.launch({headless:true});
 try{
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
  await page.route('https://**/*',route=>route.abort());
  await page.goto(origin);await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await page.getByRole('button',{name:'新建笔记',exact:true}).first().click();
  await page.getByPlaceholder('给笔记起个名字').fill('WASM 测试');await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.locator('#editor').waitFor({state:'visible'});await page.locator('#editor').fill('保存到浏览器的正文');
  await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='已保存到本机');
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await page.waitForFunction(()=>document.getElementById('editor').textContent==='保存到浏览器的正文');
  assert.equal(await page.locator('#note-list .note-row').count(),1);
  await page.getByLabel('主题').selectOption('dark');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.locator('#editor').focus();await page.keyboard.press('Meta+End');
  await page.evaluate(()=>{
   const r=document.createRange();r.selectNodeContents(document.getElementById('editor'));r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);
   const data=new DataTransfer();data.setData('text/plain','https://example.com/article');document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  assert.equal(await page.locator('#editor a').textContent(),'https://example.com/article');
  await page.route('https://example.com/title',route=>route.fulfill({status:200,headers:{'Content-Type':'text/html','Access-Control-Allow-Origin':'*'},body:'<title>网页 &amp; WASM 标题</title>'}));
  await page.evaluate(()=>{
   const editor=document.getElementById('editor');editor.focus();const r=document.createRange();r.selectNodeContents(editor);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);
   const data=new DataTransfer();data.setData('text/plain','https://example.com/title');editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  await page.waitForFunction(()=>[...document.querySelectorAll('#editor a')].some(a=>a.textContent==='网页 & WASM 标题'));
  await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='已保存到本机');
  const second=await context.newPage();await second.goto(origin);await second.waitForFunction(()=>document.body.dataset.failed==='true');
  assert((await second.locator('#status').textContent()).includes('另一个标签页'));assert.equal(await second.getByRole('button',{name:'新建笔记',exact:true}).first().isDisabled(),true);await second.close();
  const downloading=page.waitForEvent('download');await page.getByTitle('导出 HTML').click();const download=await downloading;assert(download.suggestedFilename().endsWith('.html'));
  const exported=fs.readFileSync(await download.path(),'utf8');assert(exported.includes('保存到浏览器的正文'));assert(exported.includes('https://example.com/article'));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
for(const [name,type]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: WASM OneDrive sync, conflicts and conditional deletion`,async()=>{
 const {build}=require('esbuild');
 const mock=await build({entryPoints:[path.join(root,'web/adapter.js')],bundle:true,format:'esm',write:false,external:['./pkg/cnote_web.js'],plugins:[{name:'test-auth',setup(build){build.onResolve({filter:/^@azure\/msal-browser$/},()=>({path:path.join(root,'tests/fixtures/web-auth.cjs')}));}}]});
 const browser=await type.launch({headless:true});
 try{
  const context=await browser.newContext(),page=await context.newPage(),files=new Map(),requests=[],errors=[];let number=0;
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/adapter.js',route=>route.fulfill({contentType:'text/javascript',body:mock.outputFiles[0].text}));
  await page.route('https://graph.microsoft.com/v1.0/**',async route=>{
   const req=route.request(),url=new URL(req.url()),pathname=decodeURIComponent(url.pathname),method=req.method();
   requests.push({method,pathname,headers:req.headers()});
   const json=(status,body)=>route.fulfill({status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});
   if(method==='GET'&&pathname.endsWith('/Notes:/children'))return json(200,{value:[...files.values()].map(({html,...item})=>item)});
   if(pathname.includes('/root:/Notes/')&&method==='GET')return json(404,{});
   if(method==='PUT'){
    const old=files.get(pathname.split('/items/')[1]?.split('/')[0]);
    if(old&&req.headers()['if-match']!==old.eTag)return json(412,{});
    const id=old?.id||'remote-'+(++number),item={id,name:old?.name||'Web--12345678.html',eTag:'v'+(++number),file:{},html:req.postData()};files.set(id,item);const {html,...meta}=item;return json(200,meta);
   }
   const id=pathname.split('/items/')[1]?.split('/')[0],item=files.get(id);
   if(item&&method==='GET'){
    if(pathname.endsWith('/content'))return route.fulfill({status:200,headers:{'Content-Type':'text/html','Access-Control-Allow-Origin':'*'},body:item.html});
    const {html,...meta}=item;return json(200,meta);
   }
   if(item&&method==='DELETE'){if(req.headers()['if-match']!==item.eTag)return json(412,{});files.delete(id);return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*'}});}
   return json(404,{});
  });
  await page.goto(origin);await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await page.getByRole('button',{name:'登录 OneDrive',exact:true}).click();await page.getByRole('button',{name:'退出 OneDrive',exact:true}).waitFor();
  await page.getByRole('button',{name:'新建笔记',exact:true}).first().click();await page.getByPlaceholder('给笔记起个名字').fill('Cloud note');await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.locator('#editor').fill('Local first version');
  const upload=page.waitForResponse(response=>response.url().startsWith('https://graph.microsoft.com')&&response.request().method()==='PUT');
  await page.locator('#save').click();await upload;
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('同步检查完成'));
  assert.equal(files.size,1);assert([...files.values()][0].html.includes('Local first version'));
  // Quota failure must not acknowledge or discard the new draft; retry persists it.
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){IDBObjectStore.prototype.put=put;throw new DOMException('Test quota','QuotaExceededError');};});
  await page.locator('#editor').fill('Local unsynced draft');
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('保存失败'));
  assert((await page.locator('#editor').textContent()).includes('Local unsynced draft'));
  await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='已保存到本机');
  const remote=[...files.values()][0];remote.html='<h1>Cloud changed</h1><p>Remote draft</p>';remote.eTag='external-version';
  await page.locator('#save').click();
  await page.getByRole('button',{name:'使用云端版本',exact:true}).waitFor();
  await page.getByRole('button',{name:'使用云端版本',exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).waitFor();await page.getByRole('button',{name:'完成',exact:true}).click();
  assert((await page.locator('#editor').textContent()).includes('Remote draft'));
  await page.locator('#note-list button[title^="删除"]').click();await page.getByRole('button',{name:'确认删除',exact:true}).click();
  await page.waitForResponse(response=>response.request().method()==='DELETE');
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('同步检查完成'));
  assert.equal(files.size,0);assert(requests.filter(r=>r.method==='DELETE').every(r=>r.headers['if-match']==='external-version'));
  files.set('external',{id:'external',name:'External.html',eTag:'external-v1',file:{},html:'<h1>External note</h1>'});
  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#note-list')?.textContent.includes('External note'));
  files.delete('external');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelectorAll('#note-list .note-row').length===0);
  assert(requests.every(r=>r.headers.authorization==='Bearer test-token'));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
