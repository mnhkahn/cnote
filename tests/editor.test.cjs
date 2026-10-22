const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=require('./editor-fixture.cjs')();
for(const [name,type] of [['Chromium',chromium],['WebKit',webkit]]){
 test(name,async t=>{
  const executablePath=name==='Chromium'?process.env.CNOTE_CHROMIUM_EXECUTABLE:process.env.CNOTE_WEBKIT_EXECUTABLE;
  const browser=await type.launch({headless:true,...(executablePath?{executablePath}:{})});
  try{
   const page=await browser.newPage({viewport:{width:1000,height:740}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.exposeFunction('capture',m=>{});
   // setContent executes our editor in a fresh document, with a mocked native IPC bridge.
   await page.setContent('<script>window.messages=[];window.ipc={postMessage:s=>messages.push(JSON.parse(s))};</script>'+html);
   await page.waitForFunction(()=>!!window.cnote);
   const receive=e=>page.evaluate(e=>cnote.receive(e),e);
   await t.test('offline empty state and safe title',async()=>{
    await receive({type:'load',id:'a',title:'<script>unsafe</script>',html:'<p>Hello</p>'});
    assert.equal(await page.locator('#title').textContent(),'<script>unsafe</script>');assert.equal(await page.locator('#title script').count(),0);
   });
   await t.test('Command 1–4 switches workspaces while editing without mutating drafts',async()=>{
    const editor=page.locator('#editor');await editor.click();
    const before=await editor.innerHTML();
    for(let index=0;index<4;index++){
     await page.keyboard.press('Meta+'+(index+1));
     assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='workspace').at(-1)),{type:'workspace',index});
    }
    assert.equal(await editor.innerHTML(),before);
    const count=await page.evaluate(()=>messages.filter(m=>m.type==='workspace').length);
    await page.keyboard.press('Meta+Shift+2');
    assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='workspace').length),count);
   });
   await t.test('rich HTML sanitized without losing table and tasks',async()=>{
    const safe=await page.evaluate(()=>cnote.sanitize('<script>window.pwned=1</script><img src="x" onerror="window.pwned=1"><a href="javascript:alert(1)">bad</a><table><tr><td>cell</td></tr></table><input type="checkbox" checked><iframe src="https://evil.test"></iframe>'));
    assert(!safe.includes('onerror'));assert(!safe.includes('javascript:'));assert(!safe.includes('<script'));assert(!safe.includes('<iframe'));assert(safe.includes('<td>cell</td>'));assert(safe.includes('checked'));
   });
   await t.test('switching does not wait for storage or serialize the edited note',async()=>{
    await page.locator('#editor').click();await page.keyboard.press('End');await page.keyboard.type(' written');
    await page.evaluate(()=>{window.oldEditor=document.getElementById('editor');window.beforeSwitchMessages=messages.length;cnote.action('open',{id:'b'});window.afterSwitchMessages=messages.slice(beforeSwitchMessages);});
    const immediate=await page.evaluate(()=>afterSwitchMessages);
    assert(immediate.some(m=>m.type==='open'&&m.id==='b'));
    assert(!immediate.some(m=>m.type==='change'));
    assert.equal(await page.locator('#title').textContent(),'正在打开…');
    await page.evaluate(()=>cnote.action('open',{id:'a'}));
    assert.equal(await page.evaluate(()=>document.getElementById('editor')===oldEditor),true);
    assert((await page.locator('#editor').textContent()).includes('written'));
    await page.waitForFunction(()=>messages.some(m=>m.type==='change'&&m.id==='a'));
    const edit=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='a').at(-1));
    await receive({type:'saved',id:'a',seq:edit.seq});
   });
   await t.test('checkbox state persists as HTML attribute',async()=>{
    await receive({type:'load',id:'b',title:'Tasks',html:'<div><input type="checkbox"><label>Do it</label></div>'});
    await page.locator('#editor input').check();await page.evaluate(()=>cnote.flush());const edit=await page.evaluate(()=>messages.filter(m=>m.type==='change').at(-1));assert(edit.html.includes('checked'));await receive({type:'saved',id:'b',seq:edit.seq});
   });
   await t.test('table context menu adds and removes columns',async()=>{
    await receive({type:'load',id:'c',title:'Table',html:'<table><tr><td>A</td><td>B</td></tr></table>'});await page.locator('#editor td').first().click({button:'right'});await page.locator('#context button').filter({hasText:'在右侧插入列'}).click();assert.equal(await page.locator('#editor td').count(),3);
    await page.locator('#editor td').first().click({button:'right'});await page.locator('#context button').filter({hasText:'删除列'}).click();assert.equal(await page.locator('#editor td').count(),2);
    await page.evaluate(()=>cnote.flush());const e=await page.evaluate(()=>messages.filter(m=>m.type==='change').at(-1));await receive({type:'saved',id:'c',seq:e.seq});
   });
   await t.test('Microsoft browser button leaves login pending',async()=>{
    await receive({type:'dialog',kind:'login',data:{code:'ABCD-EFGH',url:'https://microsoft.com/devicelogin'}});const before=await page.evaluate(()=>messages.filter(m=>m.type==='logout').length);
    await page.getByRole('button',{name:'打开 Microsoft 登录'}).click();assert(await page.locator('#dialog').evaluate(el=>el.open));assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='logout').length),before);
    await receive({type:'dialog',kind:'login_done',data:null});assert.equal(await page.locator('#dialog').evaluate(el=>el.open),false);
   });
   await t.test('new note dialog and native create command',async()=>{
    await page.evaluate(()=>cnote.action('new'));await page.getByPlaceholder('给笔记起个名字').fill('我的笔记');await page.getByRole('button',{name:'创建',exact:true}).click();assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='new').at(-1).title),'我的笔记');
   });
   await t.test('close waits for durable storage acknowledgment',async()=>{
    await receive({type:'load',id:'closing',title:'Close safely',html:'<p>Draft</p>'});
    await page.locator('#editor').click();await page.keyboard.type(' pending');
    const before=await page.evaluate(()=>messages.filter(m=>m.type==='close').length);
    await page.evaluate(()=>cnote.action('close'));
    assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='close').length),before);
    const edit=await page.evaluate(()=>messages.filter(m=>m.type==='change').at(-1));
    await receive({type:'saved',id:'closing',seq:edit.seq});
    await page.waitForFunction(before=>messages.filter(m=>m.type==='close').length>before,before);
   });
   await t.test('failed background save retains the original editor and allows switching',async()=>{
    await receive({type:'load',id:'failed',title:'Disk full',html:'<p>Keep this</p>'});
    await page.locator('#editor').click();await page.keyboard.type(' unsaved');
    await page.evaluate(()=>cnote.action('open',{id:'different'}));
    assert.equal(await page.locator('#title').textContent(),'正在打开…');
    await page.waitForFunction(()=>messages.some(m=>m.type==='change'&&m.id==='failed'));
    const first=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='failed').at(-1));
    await receive({type:'save_failed',id:'failed',seq:first.seq,message:'disk full'});
    await page.evaluate(()=>cnote.action('open',{id:'failed'}));
    assert((await page.locator('#editor').textContent()).includes('unsaved'));
    await page.evaluate(()=>cnote.action('save'));
    await page.waitForFunction(seq=>messages.filter(m=>m.type==='change'&&m.id==='failed'&&m.seq===seq).length>=2,first.seq);
    const edit=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='failed').at(-1));
    await receive({type:'saved',id:'failed',seq:edit.seq});
   });
   await t.test('late loads cannot replace the requested note',async()=>{
    await receive({type:'load',id:'late-a',title:'A',html:'<p>A</p>'});
    await receive({type:'load',id:'late-b',title:'B',html:'<p>B</p>'});
    await page.evaluate(()=>cnote.action('open',{id:'late-a'}));
    const token=await page.evaluate(()=>messages.filter(m=>m.type==='open').at(-1).intent);
    await receive({type:'load',intent:token-1,id:'late-b',title:'Wrong note',html:'<p>Stale content</p>'});
    assert.equal(await page.locator('#title').textContent(),'A');
   });
   await t.test('quit waits for pending writes from inactive notes too',async()=>{
    await receive({type:'load',id:'pending-a',title:'First',html:'<p>A</p>'});
    await page.locator('#editor').click();await page.keyboard.type(' first pending');
    await page.evaluate(()=>cnote.action('open',{id:'pending-b'}));
    await receive({type:'load',id:'pending-b',title:'Second',html:'<p>B</p>'});
    await page.locator('#editor').click();await page.keyboard.type(' second pending');
    const before=await page.evaluate(()=>messages.filter(m=>m.type==='close').length);
    await page.evaluate(()=>cnote.action('close'));
    const edits=await page.evaluate(()=>Object.fromEntries(messages.filter(m=>m.type==='change').map(m=>[m.id,m])));
    await receive({type:'saved',id:'pending-b',seq:edits['pending-b'].seq});
    assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='close').length),before);
    await receive({type:'saved',id:'pending-a',seq:edits['pending-a'].seq});
    await page.waitForFunction(before=>messages.filter(m=>m.type==='close').length>before,before);
   });
   await t.test('cached long-note switch fits a 16ms interaction budget',async()=>{
    const document='<p>长笔记与快速切换测试。'+ '中文内容 '.repeat(20)+'</p>';
    await receive({type:'load',id:'perf-a',title:'Performance A',html:document.repeat(1500)});
    await receive({type:'load',id:'perf-b',title:'Performance B',html:document.repeat(1500)});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const timing=await page.evaluate(()=>{
     const times=[];for(let i=0;i<80;i++){const start=performance.now();cnote.action('open',{id:i%2?'perf-b':'perf-a'});times.push(performance.now()-start);}
     times.sort((a,b)=>a-b);return {p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],max:times.at(-1)};
    });
    console.log(name,'cached switch latency (ms)',timing);
    assert(timing.p95<16,`p95 ${timing.p95}ms exceeds one 60Hz frame`);
   });
   await t.test('cached long-note switch fits two measured refresh intervals',{timeout:15000},async()=>{
    const timing=await page.evaluate(async()=>{
     // Interleave idle frames: shared CI runners can delay rAF even without a switch.
     // Keep the separate 16ms interaction budget; compare rendering against idle rAF.
     const times=[],idle=[];for(let i=0;i<24;i++){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const idleStart=performance.now();
      await new Promise(resolve=>requestAnimationFrame(resolve));idle.push(performance.now()-idleStart);
      const start=performance.now();cnote.action('open',{id:i%2?'perf-b':'perf-a'});
      await new Promise(resolve=>requestAnimationFrame(resolve));times.push(performance.now()-start);
     }
     times.sort((a,b)=>a-b);idle.sort((a,b)=>a-b);
     return {p50:times[12],p95:times[22],max:times.at(-1),idleP95:idle[22]};
    });
    console.log(name,'next-frame switch latency (ms)',timing);
    const budget=Math.max(35,timing.idleP95*2);
    assert(timing.p95<budget,`next-frame p95 ${timing.p95}ms exceeds two measured refresh intervals (${budget}ms; idle p95 ${timing.idleP95}ms)`);
   });
   await t.test('large document and screenshot' ,async()=>{
    const start=performance.now();await receive({type:'load',id:'large',title:'日常与灵感',html:'<h2>今天，记录一个新的开始。</h2><p>本地优先，随时记录。OneDrive 让想法跟随你。</p><ul><li>把复杂的事情，写得清楚一点。</li><li>留一点空间，给下一个灵感。</li></ul><div><input type="checkbox" checked><label>开始使用 CNote</label></div><p><br></p>'+'<p>性能测试 · 保留原始 HTML 与中文输入体验。</p>'.repeat(1500)});assert(performance.now()-start<5000);
    fs.mkdirSync(path.join(root,'target/previews'),{recursive:true});await page.screenshot({path:path.join(root,`target/previews/editor-${name.toLowerCase()}.png`)});
   });
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
}
