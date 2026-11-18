const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const {chromium,webkit}=require('playwright');
test('SDK pages use the shared editor and native feature protocol',async t=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'cnote-sdk-pages-'));
 cp.execFileSync(process.execPath,['scripts/build-shared-pages.cjs'],{env:{...process.env,CNOTE_SHARED_ASSETS:out}});
 const html=fs.readFileSync(path.join(out,'index.html'),'utf8');
 assert(html.includes(fs.readFileSync('editor/editor.js','utf8')));assert(html.includes(fs.readFileSync('tools/trello.js','utf8')));assert(html.includes(fs.readFileSync('tools/drive.js','utf8')));assert(!html.includes('tool-ace-source'));assert(!html.includes('id="text-tool"'));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url.startsWith('/features.html')?fs.readFileSync(path.join(out,'features.html')):html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const [name,type]of Object.entries({chromium,webkit}))await t.test(name,async()=>{
  const browser=await type.launch();const page=await browser.newPage({viewport:{width:390,height:780},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.messages=[];window.cnoteHost={postMessage:raw=>{const m=JSON.parse(raw);messages.push(m);setTimeout(()=>{
   if(m.type==='tool_ready')cnoteMobile.receive({type:'tool_state',state:{}});
   if(m.type==='change'&&!window.blockSaves)cnoteMobile.receive({type:'saved',id:m.id,seq:m.seq,title:'标题'});
   if(m.type==='tool_save')cnoteMobile.receive({type:'tool_saved',seq:m.seq});
   if(m.type==='trello')cnoteMobile.receive({type:'trello',result:{request:m.request,data:m.op==='status'?{connected:false,key:''}:{boards:[]}}});
   if(m.type==='drive')cnoteMobile.receive({type:'drive',result:{request:m.request,data:{folder:{id:'root'},items:[{id:'folder',name:'文件夹',folder:{},size:0}]}}});
  },0)}};});
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>!!window.cnoteMobile&&messages.some(m=>m.type==='mobile_ready'));
   await page.evaluate(()=>{cnoteMobile.receive({type:'state',notes:[{id:'note',title:'测试笔记'}],selected:'note',status:'离线可用',authenticated:false,account:'',cache_generation:0,cache_account:''});cnoteMobile.receive({type:'load',id:'note',title:'测试笔记',html:'<p>原文</p>'});});
   await page.locator('#editor').fill('安卓共享编辑器');await page.evaluate(()=>cnoteMobile.flush());await page.waitForFunction(()=>messages.some(m=>m.type==='change'&&m.html.includes('安卓共享编辑器')));
   await page.getByRole('button',{name:'作业',exact:true}).click();await page.waitForFunction(()=>messages.some(m=>m.type==='trello'&&m.op==='status'));assert(await page.locator('#trello-tool').isVisible());await page.locator('#trello-content').getByText('关联你的 Trello 看板',{exact:true}).first().waitFor();assert.equal(await page.locator('#trello-settings').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}),true);
   await page.getByRole('button',{name:'OneDrive',exact:true}).click();assert(await page.locator('#drive-tool').isVisible());assert(!(await page.locator('#drive-finder').isVisible()));
   await page.evaluate(()=>cnoteMobile.receive({type:'state',notes:[],selected:null,status:'已连接',authenticated:true,account:'Test',cache_generation:0,cache_account:''}));
   await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>messages.some(m=>m.type==='drive'&&m.op==='list'));await page.getByRole('option').filter({hasText:'文件夹'}).waitFor();
   await page.getByRole('button',{name:'笔记',exact:true}).click();assert(await page.locator('#mobile-notes').isVisible());
   await page.evaluate(()=>{window.blockSaves=true;});await page.locator('#editor').fill('等待确认的草稿');await page.evaluate(()=>{cnoteMobile.flush();cnote.action('install_update');});
   await page.waitForFunction(()=>messages.some(m=>m.type==='change'&&m.html.includes('等待确认的草稿')));assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='install_update')),false);
   await page.evaluate(()=>{const m=messages.filter(m=>m.type==='change').at(-1);cnoteMobile.receive({type:'saved',id:m.id,seq:m.seq,title:'标题'});});await page.waitForFunction(()=>messages.some(m=>m.type==='install_update'));
   const parts=await page.evaluate(()=>cnoteTools.compareNote({left:'<p>A</p>',right:'<p>B</p>'}));assert(parts.some(p=>p.kind==='removed'));assert(parts.some(p=>p.kind==='added'));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.goto(`http://127.0.0.1:${server.address().port}/features.html`);await page.waitForFunction(()=>!!window.cnoteMobile);
   assert.equal(await page.locator('#mobile-tabs').isVisible(),false);assert.equal(await page.locator('header').isVisible(),false);
   await page.evaluate(()=>cnoteMobile.featureMode(4));assert(await page.locator('#trello-tool').isVisible());
   await page.evaluate(()=>cnoteMobile.featureMode(5));assert(await page.locator('#drive-tool').isVisible());assert.equal(await page.locator('#mobile-notes').isVisible(),false);
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });}finally{await new Promise(r=>server.close(r));fs.rmSync(out,{recursive:true,force:true});}
});
