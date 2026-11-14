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
  await page.waitForFunction(()=>document.getElementById('editor')?.textContent==='保存到浏览器的正文');
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
for(const [name,type]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: mobile notes drawer, full-width editing and desktop layout`,async()=>{
 const browser=await type.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,acceptDownloads:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
  await page.route('https://**/*',route=>route.abort());
  await page.goto(origin);await page.waitForFunction(()=>document.body.dataset.ready==='true');
  const geometry=()=>page.evaluate(()=>({
   width:innerWidth,bodyWidth:document.body.scrollWidth,mainLeft:document.querySelector('main').getBoundingClientRect().left,mainWidth:document.querySelector('main').getBoundingClientRect().width,
   headerHeight:document.querySelector('header').getBoundingClientRect().height,toolbarWidth:document.getElementById('toolbar').clientWidth,toolbarScroll:document.getElementById('toolbar').scrollWidth,
   bodyHeight:document.body.getBoundingClientRect().height,viewportHeight:visualViewport.height
  }));
  for(const [width,height]of [[320,844],[390,844],[700,844],[844,390]]){
   await page.setViewportSize({width,height});
   await page.waitForFunction(width=>innerWidth===width&&Math.abs(document.body.getBoundingClientRect().height-visualViewport.height)<2,width);
   const g=await geometry();assert.equal(g.mainLeft,0);assert.equal(g.mainWidth,width);assert(g.bodyWidth<=width,JSON.stringify(g));assert(g.headerHeight<=130,JSON.stringify(g));assert(g.toolbarScroll>g.toolbarWidth);assert(Math.abs(g.bodyHeight-g.viewportHeight)<2,JSON.stringify(g));
   assert.equal(await page.locator('#web-sidebar').isVisible(),false);
   assert.equal(await page.locator('#image-actions').isVisible(),false);
   assert.equal(await page.locator('#export').isVisible(),false);assert.equal(await page.locator('#print').isVisible(),false);
   await page.getByRole('button',{name:'☰ 笔记',exact:true}).click();
   assert.equal(await page.getByRole('dialog',{name:'笔记列表',exact:true}).isVisible(),true);
   assert.equal(await page.locator('main').evaluate(el=>el.inert),true);
   assert.equal(await page.locator('#mobile-note-list').getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');assert.equal(await page.locator('#web-sidebar').isVisible(),false);
   assert.equal(await page.locator('#mobile-note-list').evaluate(el=>el===document.activeElement),true);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#mobile-note-list').click();await page.locator('#sidebar-shade').click({position:{x:382,y:300}});assert.equal(await page.locator('#web-sidebar').isVisible(),false);
  await page.locator('#mobile-note-list').click();await page.locator('#new-note').click();
  assert.equal(await page.locator('#web-sidebar').isVisible(),false);
  await page.getByPlaceholder('给笔记起个名字').fill('手机回归笔记');await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.locator('#editor').fill('手机全宽正文，保存后刷新仍保留。');await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='已保存到本机');
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await page.waitForFunction(()=>document.getElementById('editor')?.textContent==='手机全宽正文，保存后刷新仍保留。');
  assert.equal(await page.locator('#web-sidebar').isVisible(),false);
  await page.locator('#mobile-note-list').click();await page.locator('#note-list .note-row button').first().click();
  await page.waitForFunction(()=>!document.body.classList.contains('mobile-sidebar-open'));
  assert.equal(await page.locator('main').evaluate(el=>el.inert),false);
  await page.getByLabel('更多操作',{exact:true}).click();assert.equal(await page.getByRole('button',{name:'导出 HTML',exact:true}).isVisible(),true);assert.equal(await page.getByRole('button',{name:'打印',exact:true}).isVisible(),true);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出 HTML',exact:true}).click();const download=await downloading;
  assert(fs.readFileSync(await download.path(),'utf8').includes('手机全宽正文'));assert.equal(await page.locator('#mobile-more').getAttribute('open'),null);
  await page.evaluate(()=>{window.mobilePrintCount=0;window.print=()=>{window.mobilePrintCount++;};});
  await page.getByLabel('更多操作',{exact:true}).click();await page.getByRole('button',{name:'打印',exact:true}).click();
  await page.waitForFunction(()=>window.mobilePrintCount===1);assert.equal(await page.locator('#mobile-more').getAttribute('open'),null);

  // Resizing with an open drawer must release background inertness and retain desktop geometry.
  await page.locator('#mobile-note-list').click();await page.setViewportSize({width:1280,height:800});
  await page.waitForFunction(()=>!document.querySelector('main').inert);
  const desktop=await geometry();assert.equal(desktop.mainLeft,250);assert.equal(desktop.mainWidth,1030);
  assert.equal(await page.locator('#web-sidebar').isVisible(),true);assert.equal(await page.locator('#mobile-note-list').isVisible(),false);assert.equal(await page.locator('#mobile-more').isVisible(),false);
  assert.equal(await page.locator('#export').isVisible(),true);assert.equal(await page.locator('#print').isVisible(),true);assert.equal(await page.locator('#image-actions').isVisible(),false);
  await page.locator('#toggle-sidebar').click();assert.equal((await geometry()).mainLeft,0);
  await page.locator('#toggle-sidebar').click();assert.equal((await geometry()).mainLeft,250);
  // Keyboard-sized viewport: footer and controls stay inside the visible browser area.
  await page.setViewportSize({width:390,height:400});await page.waitForFunction(()=>Math.abs(document.body.getBoundingClientRect().height-visualViewport.height)<2);
  assert.equal((await geometry()).mainWidth,390);assert.equal(await page.locator('#web-sidebar').isVisible(),false);
  await page.getByRole('button',{name:'插入表格',exact:true}).click();
  await page.getByRole('button',{name:'插入',exact:true}).click();assert.equal(await page.locator('#editor table').count(),1);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#editor').focus();
  await page.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=240;canvas.height=140;canvas.getContext('2d').fillRect(0,0,240,140);
   const r=document.createRange();r.selectNodeContents(document.getElementById('editor'));r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);
   const clipboard=new DataTransfer();clipboard.setData('text/html',`<p><img alt="回归图片" src="${canvas.toDataURL()}"></p><p>图片后正文</p>`);
   document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));
  });
  await page.locator('#editor img').click();assert.equal(await page.locator('#image-actions').isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#image-actions').isVisible(),false);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
