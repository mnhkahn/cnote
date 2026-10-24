const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium,webkit}=require('playwright'),html=require('./editor-fixture.cjs')();
for(const [name,type]of [['Chromium',chromium],['WebKit',webkit]])test(name+' local tools offline',async t=>{
 const executablePath=name==='Chromium'?process.env.CNOTE_CHROMIUM_EXECUTABLE:process.env.CNOTE_WEBKIT_EXECUTABLE;
 const browser=await type.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
  const context=await browser.newContext({viewport:{width:1100,height:800}}),page=await context.newPage(),requests=[],errors=[];
  // WebKit's simulated offline mode also blocks blob workers. Abort every real network request instead.
  await context.route(/^https?:\/\//,route=>route.abort('internetdisconnected'));
  page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(`<script>window.messages=[];window.ipc={postMessage:raw=>{const m=JSON.parse(raw);messages.push(m);if(m.type==='tool_ready')setTimeout(()=>cnoteTools.receive({type:'tool_state',state:{}}),0);if(m.type==='tool_save'&&!window.blockToolSave)setTimeout(()=>cnoteTools.receive({type:'tool_saved',seq:m.seq}),5);if(m.type==='change')setTimeout(()=>cnote.receive({type:'saved',id:m.id,seq:m.seq}),5);if(m.type==='workspace')cnoteTools.show(m.index);}};</script>`+html);
  await page.waitForFunction(()=>window.cnote&&window.cnoteTools);
  await t.test('local text editor formats offline and preserves large integers',async()=>{
   await page.keyboard.press('Meta+2');await page.waitForSelector('#tool-text-editor .ace_text-input');
   await page.evaluate(()=>ace.edit('tool-text-editor').setValue('{"id":9007199254740993123}',-1));
   await page.getByRole('button',{name:'格式化',exact:true}).click();
   await page.waitForFunction(()=>cnoteTools.state.text.includes('\n'));
   assert((await page.evaluate(()=>cnoteTools.state.text)).includes('9007199254740993123'));
   assert.equal(await page.locator('#tool-text-editor .ace_content').evaluate(el=>getComputedStyle(el).position),'absolute');
   assert((await page.locator('#tool-text-editor .ace_text-layer').textContent()).includes('9007199254740993123'));
   await page.screenshot({path:path.join('/tmp','cnote-local-text-'+name+'.png')});
  });
  await t.test('tool editors switch theme without changing drafts',async()=>{
   const original=await page.evaluate(()=>cnoteTools.state.text);
   await page.evaluate(()=>cnoteTheme.set('dark'));
   assert.equal(await page.locator('#local-tools').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(25, 30, 41)');
   assert.equal(await page.locator('#tool-text-editor').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(25, 30, 41)');
   for(const theme of require('../editor/themes.json')){
    await page.evaluate(id=>cnoteTheme.set(id),theme.id);
    const expected='rgb('+theme.bg.match(/../g).map(v=>parseInt(v,16)).join(', ')+')';
    assert.equal(await page.locator('#local-tools').evaluate(el=>getComputedStyle(el).backgroundColor),expected);
    assert.equal(await page.locator('#tool-text-editor').evaluate(el=>getComputedStyle(el).backgroundColor),expected);
    assert.equal(await page.evaluate(()=>cnoteTools.state.text),original);
   }
   await page.evaluate(()=>cnoteTheme.set('light'));
   assert.equal(await page.locator('#tool-text-editor').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
   assert.equal(await page.evaluate(()=>cnoteTools.state.text),original);
   await page.evaluate(()=>cnoteTheme.set('system'));
  });
  await t.test('editing menu targets the focused input instead of the text editor',async()=>{
   await page.locator('#text-pattern').fill('pattern');
   await page.evaluate(()=>cnoteTools.edit('selectAll'));
   assert.deepEqual(await page.locator('#text-pattern').evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,7]);
   assert.equal(await page.locator('#text-pattern').evaluate(el=>document.activeElement===el),true);
   await page.evaluate(()=>ace.edit('tool-text-editor').focus());
   await page.evaluate(()=>cnoteTools.edit('selectAll'));
   assert.equal(await page.evaluate(()=>ace.edit('tool-text-editor').getSelectedText()),await page.evaluate(()=>cnoteTools.state.text));
  });
  await t.test('AI text formats through the offline worker and remains undoable',async()=>{
   const input='第一段被截\r\n    断了。\r\n\r\n    Hello\r\n    world\r\n    https://example.com/long\r\n    /path.html';
   await page.locator('#text-mode').selectOption('auto');
   await page.evaluate(value=>ace.edit('tool-text-editor').setValue(value,-1),input);
   const original=await page.evaluate(()=>cnoteTools.state.text);
   await page.getByRole('button',{name:'格式化',exact:true}).click();
   await page.waitForFunction(()=>cnoteTools.state.text==='第一段被截断了。\n\nHello world https://example.com/long/path.html');
   await page.evaluate(()=>cnoteTools.edit('undo'));
   assert.equal(await page.evaluate(()=>cnoteTools.state.text),original.replace(/\r\n/g,'\n'));
   await page.locator('#text-mode').selectOption('ai-text');
   await page.evaluate(()=>ace.edit('tool-text-editor').setValue('没有缩进\n也能手动合并',-1));
   await page.getByRole('button',{name:'格式化',exact:true}).click();
   await page.waitForFunction(()=>cnoteTools.state.text==='没有缩进也能手动合并');
   await page.locator('#text-mode').selectOption('auto');
  });
  await t.test('arrow characters cannot be inserted into Ace or tool inputs',async()=>{
   await page.evaluate(()=>ace.edit('tool-text-editor').focus());
   const original=await page.evaluate(()=>cnoteTools.state.text);
   for(const character of ['\u001e','\uf701'])await page.keyboard.insertText(character);
   assert.equal(await page.evaluate(()=>cnoteTools.state.text),original);
   await page.locator('#text-pattern').fill('pattern');
   for(const character of ['\u001e','\uf701'])await page.keyboard.insertText(character);
   assert.equal(await page.locator('#text-pattern').inputValue(),'pattern');
  });
  await t.test('an asynchronous transform cannot overwrite newer typing',async()=>{
   await page.evaluate(()=>{window.originalWorkerPost=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){if(args[0].task==='textOp')setTimeout(()=>originalWorkerPost.apply(this,args),150);else originalWorkerPost.apply(this,args);};ace.edit('tool-text-editor').setValue('{"old":1}',-1);});
   await page.getByRole('button',{name:'格式化',exact:true}).click();
   await page.evaluate(()=>ace.edit('tool-text-editor').setValue('new typing',-1));
   await page.waitForFunction(()=>document.getElementById('tool-status').textContent.includes('已保留新输入'));
   assert.equal(await page.evaluate(()=>cnoteTools.state.text),'new typing');
   await page.evaluate(()=>Worker.prototype.postMessage=originalWorkerPost);
  });
  await t.test('invalid JSON and regex preserve input and report errors',async()=>{
   await page.evaluate(()=>ace.edit('tool-text-editor').setValue('{invalid',-1));
   await page.getByRole('button',{name:'格式化',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('tool-status').dataset.error==='true');
   assert.equal(await page.evaluate(()=>cnoteTools.state.text),'{invalid');
   await page.locator('#text-pattern').fill('[');await page.getByRole('button',{name:'按行过滤',exact:true}).click();
   await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>cnoteTools.state.text),'{invalid');
  });
  await t.test('diff works offline, switching keeps both editor documents',async()=>{
   await page.keyboard.press('Meta+3');
   await page.evaluate(()=>{ace.edit('tool-diff-left').setValue('same\nold\n',-1);ace.edit('tool-diff-right').setValue('same\nnew\n',-1);});
   await page.waitForFunction(()=>document.getElementById('diff-count').textContent==='+1 / −1');
   assert.equal(await page.locator('#diff-output .removed').count(),1);assert.equal(await page.locator('#diff-output .added').count(),1);
   await page.keyboard.press('Meta+2');assert.equal(await page.evaluate(()=>ace.edit('tool-text-editor').getValue()),'{invalid');
   await page.keyboard.press('Meta+3');assert.equal(await page.evaluate(()=>ace.edit('tool-diff-right').getValue()),'same\nnew\n');
  });
  await t.test('Command 1 resumes the note at its saved caret position',async()=>{
   await page.evaluate(()=>{
    cnote.receive({type:'load',id:'resume',title:'Resume',html:'<p>Hello</p>'});
    const editor=document.getElementById('editor');editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
   });
   await page.waitForTimeout(30);await page.keyboard.press('Meta+2');await page.keyboard.press('Meta+1');await page.keyboard.type(' world');
   assert.equal(await page.locator('#editor').textContent(),'Hello world');
  });
  await t.test('CSV import, cell edits, numeric sorting, transpose and undo',async()=>{
   await page.keyboard.press('Meta+4');await page.locator('#table-input').fill('name,n\nx,10\ny,2');await page.locator('#table-import').click();
   await page.waitForSelector('#table-grid tbody tr');assert.equal(await page.locator('#table-grid tbody tr').count(),2);
   await page.locator('#table-column').selectOption('1');await page.getByRole('button',{name:'升序',exact:true}).click();
   await page.waitForFunction(()=>cnoteTools.state.rows[1][0]==='y');
   const cell=page.locator('#table-grid tbody input').first();await cell.fill('edited');await cell.blur();
   assert.equal(await page.evaluate(()=>cnoteTools.state.rows[1][0]),'edited');
   await page.locator('#table-undo').click();assert.equal(await page.evaluate(()=>cnoteTools.state.rows[1][0]),'y');
   await page.getByRole('button',{name:'转置',exact:true}).click();await page.waitForFunction(()=>cnoteTools.state.rows.length===2&&cnoteTools.state.rows[0].length===3);
   await page.locator('#table-undo').click();assert.equal(await page.evaluate(()=>cnoteTools.state.rows[0][0]),'name');
   await page.screenshot({path:path.join('/tmp','cnote-local-csv-'+name+'.png')});
  });
  await t.test('HTML import removes executable markup and exports local bytes',async()=>{
   await page.locator('#table-import-format').selectOption('html');await page.locator('#table-input').fill('<table><tr><th>x</th></tr><tr><td><img src="https://never.test/pixel.png" onerror="evil()">&lt;script&gt;evil()&lt;/script&gt;</td></tr></table>');await page.locator('#table-import').click();
   assert.equal(await page.evaluate(()=>cnoteTools.state.rows[1][0]),'<script>evil()</script>');assert.equal(await page.locator('#table-grid script').count(),0);
   await page.locator('#table-export-format').selectOption('xlsx');await page.locator('#table-export').click();
   await page.waitForFunction(()=>messages.some(m=>m.type==='tool_export'));
   const result=await page.evaluate(()=>messages.filter(m=>m.type==='tool_export').at(-1));assert.equal(result.filename,'CNote-table.xlsx');assert.equal(Buffer.from(result.data,'base64').subarray(0,2).toString(),'PK');
  });
  await t.test('quit waits for tool drafts as well as notes',async()=>{
   await page.evaluate(()=>{window.blockToolSave=true;ace.edit('tool-text-editor').setValue('must persist',-1);cnote.action('close');});
   await page.waitForFunction(()=>messages.some(m=>m.type==='tool_save'&&m.state.text==='must persist'));
   assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='close')),false);
   await page.evaluate(()=>cnoteTools.receive({type:'tool_saved',seq:messages.filter(m=>m.type==='tool_save').at(-1).seq}));
   await page.waitForFunction(()=>messages.some(m=>m.type==='close'));
  });
  assert.deepEqual(requests,[],'local tools requested network resources');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
