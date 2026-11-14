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
   await t.test('format shortcuts toggle selections, format new typing, save and respect focus',async()=>{
    const formatPage=await browser.newPage();
    try{
     await formatPage.setContent('<script>window.messages=[];window.ipc={postMessage:s=>messages.push(JSON.parse(s))};</script>'+html);
     for(const [key,cmd] of [['b','bold'],['i','italic'],['u','underline']]){
      await formatPage.evaluate(key=>{cnote.receive({type:'load',id:'format-'+key,title:'Format',html:'<p>Format me</p>'});cnote.focusEditor();const r=document.createRange();r.selectNodeContents(document.getElementById('editor'));getSelection().removeAllRanges();getSelection().addRange(r);},key);
      const state=()=>formatPage.evaluate(cmd=>document.queryCommandState(cmd),cmd);
      await formatPage.keyboard.press('Meta+'+key);assert.equal(await state(),true);
      await formatPage.evaluate(()=>cnote.flush());
      const saved=await formatPage.evaluate(()=>messages.filter(m=>m.type==='change').at(-1));assert.notEqual(saved.html,'<p>Format me</p>');assert.equal(saved.id,'format-'+key);
      await formatPage.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await state(),false);
      await formatPage.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await state(),true);
      await formatPage.keyboard.press('Meta+'+key);assert.equal(await state(),false);
      await formatPage.evaluate(()=>getSelection().collapseToEnd());
      await formatPage.keyboard.press('Meta+'+key);await formatPage.keyboard.type(' extra');assert.equal(await state(),true);
      await formatPage.keyboard.press('Meta+'+key);await formatPage.keyboard.type(' plain');assert.equal(await state(),false);
      assert.equal((await formatPage.locator('#editor').textContent()).replaceAll('\u00a0',' '),'Format me extra plain');
      await formatPage.evaluate(()=>cnote.flush());assert((await formatPage.evaluate(()=>messages.filter(m=>m.type==='change').at(-1).html)).includes('extra'));
     }
     const before=await formatPage.locator('#editor').innerHTML();
     await formatPage.evaluate(()=>cnote.action('new'));
     assert.equal(await formatPage.evaluate(()=>cnote.formatShortcut('bold')),false);
     await formatPage.getByPlaceholder('给笔记起个名字').fill('Dialog text');await formatPage.keyboard.press('Meta+b');
     assert.equal(await formatPage.locator('#editor').innerHTML(),before);
     await formatPage.getByRole('button',{name:'取消',exact:true}).click();
     await formatPage.evaluate(()=>cnoteTools.show(1));assert.equal(await formatPage.evaluate(()=>cnote.formatShortcut('bold')),false);
     assert.equal(await formatPage.locator('#editor').innerHTML(),before);
    }finally{await formatPage.close();}
   });
   await t.test('scroll range shrinks after deletion and ignores cached inactive notes',async()=>{
    const scrollPage=await browser.newPage({viewport:{width:1000,height:740}});scrollPage.setDefaultTimeout(5000);
    try{
     await scrollPage.setContent('<script>window.ipc={postMessage:()=>{}};</script>'+html);
     const load=(id,html)=>scrollPage.evaluate(({id,html})=>cnote.receive({type:'load',id,title:'Scroll test',html}),{id,html});
     const height=()=>scrollPage.locator('main').evaluate(el=>el.scrollHeight);
     await load('short-scroll','<p>Short note</p>');
     await scrollPage.waitForFunction(()=>document.querySelector('.editor-stack').offsetHeight>=370);
     const shortHeight=await height();
     await load('long-scroll','<p>Long paragraph with enough text to wrap in a narrow window.</p>'.repeat(200));
     await scrollPage.waitForFunction(()=>document.querySelector('main').scrollHeight>5000);
     const longHeight=await height();
     await scrollPage.locator('#editor').focus();await scrollPage.keyboard.press('Meta+A');await scrollPage.keyboard.press('Backspace');
     await scrollPage.waitForFunction(limit=>document.querySelector('main').scrollHeight<=limit+2,shortHeight);
     assert((await scrollPage.locator('main').evaluate(el=>el.scrollTop))<=shortHeight);
     await scrollPage.getByRole('button',{name:'撤销',exact:true}).click();
     await scrollPage.waitForFunction(limit=>document.querySelector('main').scrollHeight>=limit-2,longHeight);
     await scrollPage.locator('main').evaluate(el=>{el.scrollTop=el.scrollHeight;});
     await scrollPage.evaluate(()=>cnote.action('open',{id:'short-scroll'}));
     await scrollPage.waitForFunction(limit=>document.querySelector('main').scrollHeight<=limit+2,shortHeight);
     assert.equal(await scrollPage.locator('main').evaluate(el=>el.scrollTop),0);
     await scrollPage.setViewportSize({width:600,height:500});
     await scrollPage.waitForFunction(()=>document.querySelector('main').scrollHeight<1000);
     await scrollPage.evaluate(()=>cnote.action('open',{id:'long-scroll'}));
     await scrollPage.waitForFunction(()=>document.querySelector('main').scrollHeight>5000);
    }finally{await scrollPage.close();}
   });
   await t.test('offline empty state and safe title',async()=>{
    await receive({type:'load',id:'a',title:'<script>unsafe</script>',html:'<p>Hello</p>'});
    assert.equal(await page.locator('#title').textContent(),'<script>unsafe</script>');assert.equal(await page.locator('#title script').count(),0);
   });
   await t.test('conflict diff selects individual changes and preserves rich HTML',async()=>{
    const local='<h1>共同标题</h1><p><b>本地段落</b></p><p>中间内容</p><p>本地结尾</p>';
    const cloud='<h1>共同标题</h1><p><i>云端段落</i></p><p>中间内容</p><p>云端结尾</p>';
    await receive({type:'load',id:'conflict-note',title:'冲突笔记',html:local});
    await receive({type:'dialog',kind:'conflict',data:{id:'conflict-note'}});
    assert(await page.evaluate(()=>messages.some(m=>m.type==='conflict_view'&&m.id==='conflict-note')));
    await receive({type:'dialog',kind:'conflict_view',data:{id:'conflict-note',title:'冲突笔记',local,cloud,revision:7,etag:'remote-tag'}});
    await page.waitForFunction(()=>document.querySelectorAll('.conflict-change').length===2);
    assert(await page.locator('.conflict-line-numbers').count()>0);
    await page.getByRole('button',{name:'查看内容差异',exact:true}).click();
    assert(await page.getByRole('button',{name:'保存合并结果',exact:true}).isDisabled());
    assert((await page.locator('.conflict-preview').textContent()).includes('还有 2 处差异待选择'));
    await page.locator('.conflict-change').first().getByRole('button',{name:'选择云端'}).click();
    assert(await page.getByRole('button',{name:'保存合并结果',exact:true}).isDisabled());
    await page.locator('.conflict-change').nth(1).getByRole('button',{name:'选择本地'}).click();
    assert((await page.locator('#dialog-body').textContent()).includes('本地 1 处 · 云端 1 处 · 待选择 0 处'));
    assert.equal(await page.locator('.conflict-preview').innerHTML(),'<h1>共同标题</h1><p><i>云端段落</i></p><p>中间内容</p><p>本地结尾</p>');
    await page.getByRole('button',{name:'查看 HTML 差异',exact:true}).click();
    assert((await page.locator('.conflict-change pre').first().textContent()).includes('<b>本地段落</b>'));
    await page.getByRole('button',{name:'保存合并结果',exact:true}).click();
    const resolution=await page.evaluate(()=>messages.filter(m=>m.type==='resolve').at(-1));
    assert.equal(resolution.choice,'merge');assert.equal(resolution.revision,7);assert.equal(resolution.etag,'remote-tag');
    assert.equal(resolution.html,'<h1>共同标题</h1><p><i>云端段落</i></p><p>中间内容</p><p>本地结尾</p>');
    assert.equal(await page.locator('#dialog').evaluate(el=>el.open),true);
    assert(await page.getByRole('button',{name:'保存合并结果',exact:true}).isDisabled());
    await receive({type:'dialog',kind:'conflict_result',data:{id:'conflict-note',ok:false,message:'云端版本已更新'}});
    assert((await page.locator('#dialog-body').textContent()).includes('未能保存选择：云端版本已更新'));
    assert.equal(await page.locator('#editor').innerHTML(),local);
    await page.getByRole('button',{name:'保存合并结果',exact:true}).click();
    await receive({type:'dialog',kind:'conflict_result',data:{id:'conflict-note',ok:true,choice:'merge',html:resolution.html,pending_sync:true}});
    assert.equal(await page.locator('#dialog-title').textContent(),'已应用你的选择');
    assert((await page.locator('#dialog-body').textContent()).includes('差异 1：使用云端；差异 2：保留本地'));
    assert((await page.locator('#dialog-body').textContent()).includes('已保存到本机，等待同步到 OneDrive'));
    assert.equal(await page.getByLabel('已保存的笔记内容').innerHTML(),resolution.html);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await receive({type:'load',id:'a',title:'Note',html:'<p>Hello</p>'});
   });
   await t.test('conflict arrows send either side into the center result in both views',async()=>{
    const local='<div>easejob支持age</div>',cloud='<div>EDrive 文件系统，看看还缺什么东西。</div>';
    await receive({type:'dialog',kind:'conflict_view',data:{id:'card-conflict',title:'OpenClaw',local,cloud,revision:8,etag:'card-tag'}});
    await page.waitForSelector('.conflict-change');
    await page.getByRole('button',{name:'查看内容差异',exact:true}).click();
    assert.equal(await page.locator('.conflict-arrow.mine').textContent(),'→');
    assert.equal(await page.locator('.conflict-arrow.cloud').textContent(),'←');
    await page.locator('.conflict-arrow.mine').click();
    assert.equal(await page.locator('.conflict-arrow.mine').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.conflict-preview').innerHTML(),local);
    await page.getByRole('button',{name:'查看 HTML 差异',exact:true}).click();
    assert.equal(await page.locator('.conflict-version.result .conflict-content').textContent(),'<div>easejob支持age</div>');
    await page.locator('.conflict-arrow.cloud').click();
    assert.equal(await page.locator('.conflict-arrow.cloud').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.conflict-preview').innerHTML(),cloud);
    assert.equal(await page.locator('.conflict-version.result .conflict-content').textContent(),cloud);
    await page.locator('.conflict-arrow.mine').click();
    assert.equal(await page.locator('.conflict-preview').innerHTML(),local);
    await page.locator('.conflict-arrow.cloud').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.conflict-preview').innerHTML(),cloud);
    await page.getByRole('button',{name:'保存合并结果',exact:true}).click();
    const result=await page.evaluate(()=>messages.filter(m=>m.type==='resolve').at(-1));
    assert.equal(result.choice,'merge');assert.equal(result.html,cloud);
    await receive({type:'dialog',kind:'conflict_result',data:{id:'card-conflict',ok:true,choice:'merge',html:cloud,pending_sync:true}});
    await page.getByRole('button',{name:'完成',exact:true}).click();
   });
   await t.test('theme overrides system appearance and can resume following it',async()=>{
    await page.emulateMedia({colorScheme:'light'});
    await receive({type:'theme',theme:'dark'});
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(25, 30, 41)');
    assert.equal(await page.locator('#save').evaluate(el=>getComputedStyle(el).color),'rgb(17, 17, 17)');
    await page.emulateMedia({colorScheme:'dark'});
    await receive({type:'theme',theme:'light'});
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    await receive({type:'theme',theme:'system'});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
   });
   await t.test('all 20 palettes switch without changing content and remain readable',async()=>{
    const themes=require('../editor/themes.json');
    assert.equal(themes.length,20);
    const original=await page.locator('#editor').innerHTML();
    const luminance=hex=>{
     const c=hex.match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
     return c[0]*.2126+c[1]*.7152+c[2]*.0722;
    };
    const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
    for(const theme of themes){
     await page.emulateMedia({colorScheme:theme.dark?'light':'dark'});
     await receive({type:'theme',theme:theme.id});
     const result=await page.evaluate(()=>({id:document.documentElement.dataset.theme,appearance:document.documentElement.dataset.appearance,bg:getComputedStyle(document.body).backgroundColor,accent:getComputedStyle(document.getElementById('save')).backgroundColor}));
     const rgb=hex=>'rgb('+hex.match(/../g).map(v=>parseInt(v,16)).join(', ')+')';
     assert.equal(result.id,theme.id);
     assert.equal(result.appearance,theme.dark?'dark':'light');
     assert.equal(result.bg,rgb(theme.bg));assert.equal(result.accent,rgb(theme.accent));
     assert(contrast(theme.ink,theme.bg)>=4.5,theme.id+' body contrast');
     assert(contrast(theme.dark?'111111':'ffffff',theme.accent)>=4.5,theme.id+' button contrast');
     assert.equal(await page.locator('#editor').innerHTML(),original);
    }
    await receive({type:'theme',theme:'unknown'});
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'charcoal');
    await receive({type:'theme',theme:'system'});
    await page.emulateMedia({colorScheme:'light'});
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
   await t.test('arrow characters cannot be inserted as note text',async()=>{
    const original=await page.locator('#editor').innerHTML();
    await page.locator('#editor').focus();
    for(const key of ['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Shift+ArrowRight'])await page.keyboard.press(key);
    for(const character of ['\u001c','\u001d','\u001e','\u001f','\uf700','\uf701','\uf702','\uf703'])await page.keyboard.insertText(character);
    assert.equal(await page.locator('#editor').innerHTML(),original);
    assert.equal(await page.locator('#editor').evaluate(el=>el.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'正常文字',bubbles:true,cancelable:true}))),true);
    assert.equal(await page.locator('#editor').evaluate(el=>el.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertFromPaste',data:'\uf701',bubbles:true,cancelable:true}))),true);
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
   await t.test('table dialog inserts at the saved caret and supports save and undo',async()=>{
    const original='<p>Before</p><p>After</p>';
    await receive({type:'load',id:'insert-table',title:'Insert table',html:original});
    await page.locator('#editor').focus();
    await page.evaluate(()=>{const r=document.createRange();r.setStartAfter(document.querySelector('#editor p'));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);});
    await page.getByRole('button',{name:'插入表格',exact:true}).click();
    await page.locator('#dialog-body input').nth(0).fill('2');
    await page.locator('#dialog-body input').nth(1).fill('4');
    await page.getByRole('button',{name:'插入',exact:true}).click();
    assert.equal(await page.locator('#dialog').evaluate(el=>el.open),false);
    assert.equal(await page.locator('#editor table tr').count(),2);
    assert.equal(await page.locator('#editor table th').count(),4);
    assert.equal(await page.locator('#editor table td').count(),4);
    assert(await page.locator('#editor table').evaluate(el=>el.previousElementSibling?.textContent==='Before'&&el.nextElementSibling?.nextElementSibling?.textContent==='After'));
    await page.evaluate(()=>cnote.flush());
    const saved=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='insert-table').at(-1));
    assert(saved.html.includes('<table>'));await receive({type:'saved',id:'insert-table',seq:saved.seq});
    await page.getByRole('button',{name:'撤销',exact:true}).click();
    assert.equal(await page.locator('#editor').innerHTML(),original);
    await page.getByRole('button',{name:'插入表格',exact:true}).click();
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.locator('#editor').innerHTML(),original);
    await page.evaluate(()=>cnote.flush());
    const undone=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='insert-table').at(-1));
    await receive({type:'saved',id:'insert-table',seq:undone.seq});
    await receive({type:'load',id:'empty-table',title:'Empty table',html:''});
    await page.getByRole('button',{name:'插入表格',exact:true}).click();
    await page.getByRole('button',{name:'插入',exact:true}).click();
    assert.equal(await page.locator('#editor table tr').count(),3);
    await page.evaluate(()=>cnote.flush());
    const empty=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='empty-table').at(-1));
    await receive({type:'saved',id:'empty-table',seq:empty.seq});
   });
   await t.test('table context menu adds and removes columns',async()=>{
    await receive({type:'load',id:'c',title:'Table',html:'<table><tr><td>A</td><td>B</td></tr></table>'});await page.locator('#editor td').first().click({button:'right'});await page.locator('#context button').filter({hasText:'在右侧插入列'}).click();assert.equal(await page.locator('#editor td').count(),3);
    await page.locator('#editor td').first().click({button:'right'});await page.locator('#context button').filter({hasText:'删除列'}).click();assert.equal(await page.locator('#editor td').count(),2);
    await page.evaluate(()=>cnote.flush());const e=await page.evaluate(()=>messages.filter(m=>m.type==='change').at(-1));await receive({type:'saved',id:'c',seq:e.seq});
   });
   await t.test('images support selection, zoom, native clipboard and undoable cut',async()=>{
    const src=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=140;const ctx=c.getContext('2d');ctx.fillStyle='#e7f0ff';ctx.fillRect(0,0,240,140);ctx.fillStyle='#0d6efd';ctx.fillText('CNote image',30,70);return c.toDataURL('image/png');});
    await receive({type:'load',id:'image-note',title:'Images',html:`<p>Before</p><p><a href="https://example.com"><img src="${src}" alt="示例图片"></a></p><p>After</p>`});
    assert.equal(await page.locator('#image-actions').isVisible(),false);
    assert.equal(await page.locator('#image-selection').isVisible(),false);
    await page.locator('#editor img').click();
    assert.equal(await page.locator('#image-actions').isVisible(),true);
    assert.equal(await page.evaluate(()=>getSelection().getRangeAt(0).cloneContents().querySelectorAll('img').length),1);
    assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='change'&&m.id==='image-note')),false);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#image-actions').isVisible(),false);assert.equal(await page.evaluate(()=>getSelection().isCollapsed),true);
    await page.locator('#editor img').click();
    await page.locator('#image-actions').getByRole('button',{name:'放大查看',exact:true}).click();
    await page.waitForSelector('dialog.image-dialog img');
    const width=await page.locator('dialog.image-dialog img').evaluate(el=>el.getBoundingClientRect().width);
    await page.locator('#dialog-actions').getByRole('button',{name:'放大',exact:true}).click();
    assert((await page.locator('dialog.image-dialog img').evaluate(el=>el.getBoundingClientRect().width))>width);
    await page.keyboard.press('Escape');
    await page.locator('#editor img').dblclick();assert(await page.locator('dialog.image-dialog').evaluate(el=>el.open));
    await page.locator('#dialog-actions').getByRole('button',{name:'关闭',exact:true}).click();
    await page.locator('#editor img').click();await page.locator('#image-actions').getByRole('button',{name:'复制图片',exact:true}).click();
    let request=await page.evaluate(()=>messages.filter(m=>m.type==='image_clipboard').at(-1));assert.equal(request.src,src);assert(request.html.includes('示例图片'));
    await receive({type:'image_clipboard_result',token:request.token,ok:true});
    assert((await page.locator('#status').textContent()).includes('图片已复制'));assert.equal(await page.locator('#editor img').count(),1);
    await page.locator('#editor img').click({button:'right'});await page.locator('#context').getByRole('button',{name:'剪切图片',exact:true}).click();
    request=await page.evaluate(()=>messages.filter(m=>m.type==='image_clipboard').at(-1));
    assert.equal(await page.locator('#editor img').count(),1,'cut must wait for the clipboard acknowledgement');
    await receive({type:'image_clipboard_result',token:request.token,ok:false,message:'test clipboard failure'});
    assert.equal(await page.locator('#editor img').count(),1);assert((await page.locator('#status').textContent()).includes('原图已保留'));
    await page.locator('#image-actions').getByRole('button',{name:'剪切图片',exact:true}).click();
    request=await page.evaluate(()=>messages.filter(m=>m.type==='image_clipboard').at(-1));await receive({type:'image_clipboard_result',token:request.token,ok:true});
    assert.equal(await page.locator('#editor img').count(),0);
    await page.evaluate(()=>document.execCommand('undo'));assert.equal(await page.locator('#editor img').count(),1);
    await page.evaluate(()=>cnote.flush());const saved=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id==='image-note').at(-1));
    assert(saved.html.includes(src));assert(!saved.html.includes('image-selection'));assert(!saved.html.includes('image-actions'));
    await receive({type:'saved',id:'image-note',seq:saved.seq});
    await page.locator('#editor img').click();
    const prevented=await page.evaluate(()=>!document.getElementById('editor').dispatchEvent(new ClipboardEvent('cut',{bubbles:true,cancelable:true})));
    assert(prevented);request=await page.evaluate(()=>messages.filter(m=>m.type==='image_clipboard').at(-1));
    await receive({type:'load',id:'other-image-note',title:'Other',html:'<p>Other note</p>'});
    await receive({type:'image_clipboard_result',token:request.token,ok:true});
    await receive({type:'load',id:'image-note',title:'Images',html:saved.html});assert.equal(await page.locator('#editor img').count(),1);
    assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='link'&&m.url==='https://example.com/')),false);
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
