const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright'),html=require('./editor-fixture.cjs')();
for(const [name,type] of [['Chromium',chromium],['WebKit',webkit]])test(name+' note shortcuts',async t=>{
 const executablePath=name==='Chromium'?process.env.CNOTE_CHROMIUM_EXECUTABLE:process.env.CNOTE_WEBKIT_EXECUTABLE;
 const browser=await type.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];let serial=0;
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(5000);
  await page.setContent('<script>window.messages=[];window.ipc={postMessage:s=>{const m=JSON.parse(s);messages.push(m);if(m.type==="change")setTimeout(()=>cnote.receive({type:"saved",id:m.id,seq:m.seq}),0);}};</script>'+html);
  const select=async(selector='#editor',collapse=false)=>page.locator(selector).evaluate((el,collapse)=>{document.getElementById('editor').focus();const r=document.createRange();r.selectNodeContents(el);if(collapse)r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);},collapse);
  const reset=async(source='<p>Sample text</p>')=>{await page.evaluate(({source,id})=>{cnoteTools.show(0);cnote.receive({type:'load',id,title:'Shortcuts',html:source});},{source,id:'shortcut-'+(++serial)});await select();};
  const press=chord=>page.keyboard.press(chord);
  await t.test('headings, paragraph, strike, code and quote preserve text and toggle',async()=>{
   for(let level=1;level<=3;level++){await reset();await press('Meta+Alt+'+level);assert.equal(await page.locator('#editor h'+level).textContent(),'Sample text');await press('Meta+Alt+0');assert.equal(await page.locator('#editor p').textContent(),'Sample text');}
   await reset();await press('Meta+Shift+x');assert.equal(await page.evaluate(()=>document.queryCommandState('strikeThrough')),true);await press('Meta+Shift+x');assert.equal(await page.evaluate(()=>document.queryCommandState('strikeThrough')),false);
   for(const [chord,tag] of [['Meta+e','code'],['Meta+Shift+c','pre'],['Meta+Shift+b','blockquote']]){await reset();await press(chord);assert.equal(await page.locator('#editor '+tag).textContent(),'Sample text');await select('#editor '+tag);await press(chord);assert.equal(await page.locator('#editor '+tag).count(),0);assert.equal(await page.locator('#editor').textContent(),'Sample text');}
  });
  await t.test('lists, tasks, indent, alignment and clear formatting',async()=>{
   for(const [chord,tag] of [['Meta+Shift+7','ol'],['Meta+Shift+8','ul']]){await reset('<p>Alpha</p><p>Beta</p>');await press(chord);assert.equal(await page.locator('#editor '+tag+' li').count(),2);await press(chord);assert.equal(await page.locator('#editor '+tag).count(),0);}
   await reset();await press('Meta+Shift+9');assert.equal(await page.locator('#editor input[type=checkbox]').count(),1);assert.equal(await page.locator('#editor label').textContent(),'Sample text');
   await reset();await press('Meta+]');assert.equal(await page.locator('#editor blockquote').count(),1);await press('Meta+[');assert.equal(await page.locator('#editor blockquote').count(),0);
   for(const [key,alignment] of [['e','center'],['r','right'],['j','justify'],['l','left']]){await reset();await press('Meta+Shift+'+key);assert([alignment,...(alignment==='left'?['start']:[])].includes(await page.locator('#editor').evaluate(el=>getComputedStyle(el.firstElementChild).textAlign)));await page.evaluate(()=>cnote.flush());const saved=await page.evaluate(()=>messages.filter(m=>m.type==='change').at(-1).html);assert.equal(saved,await page.locator('#editor').innerHTML());}
   await reset('<p><b><i>Sample text</i></b></p>');await press('Meta+Shift+Backslash');assert.equal(await page.evaluate(()=>document.queryCommandState('bold')||document.queryCommandState('italic')),false);
  });
  await t.test('link dialog validates URLs, keeps selection, edits and removes links',async()=>{
   await reset();await press('Meta+k');await page.getByRole('textbox',{name:'链接地址'}).fill('javascript:alert(1)');await page.locator('#dialog-actions').getByRole('button',{name:'保存',exact:true}).click();assert.equal(await page.locator('#dialog').evaluate(el=>el.open),true);
   await page.getByRole('textbox',{name:'链接地址'}).fill('https://example.com/first');await page.locator('#dialog-actions').getByRole('button',{name:'保存',exact:true}).click();assert.equal(await page.locator('#editor a').textContent(),'Sample text');
   await select('#editor a',true);await press('Meta+k');assert.equal(await page.getByRole('textbox',{name:'链接地址'}).inputValue(),'https://example.com/first');await page.getByRole('textbox',{name:'链接地址'}).fill('https://example.com/second');await page.getByRole('textbox',{name:'链接地址'}).press('Enter');assert.equal(await page.locator('#editor a').getAttribute('href'),'https://example.com/second');
   await select('#editor a');await press('Meta+Shift+k');assert.equal(await page.locator('#editor a').count(),0);assert.equal(await page.locator('#editor').textContent(),'Sample text');
  });
  await t.test('find is restricted to the current note and supports next, previous and Escape',async()=>{
   await reset('<p>hidden needle</p>');await reset('<p>Need<b>le</b> one; needle two; [literal]</p>');const before=await page.locator('#editor').innerHTML();await select('#editor',true);await press('Meta+f');const input=page.getByRole('searchbox',{name:'查找当前笔记'});await input.fill('needle');assert.equal(await page.locator('#note-find span').textContent(),'1 / 2');assert(await page.locator('.note-find-mark').count()>0);
   await input.press('Enter');assert.equal(await page.locator('#note-find span').textContent(),'2 / 2');await press('Meta+g');assert.equal(await page.locator('#note-find span').textContent(),'1 / 2');await press('Meta+Shift+g');assert.equal(await page.locator('#note-find span').textContent(),'2 / 2');
   await input.fill('[literal]');assert.equal(await page.locator('#note-find span').textContent(),'1 / 1');await press('Escape');assert.equal(await page.locator('#note-find').isVisible(),false);assert.equal(await page.locator('#editor').innerHTML(),before);
  });
  await t.test('plain paste skips formatting and table parsing; print and help are discoverable',async()=>{
   await reset('<p></p>');await page.locator('#editor').evaluate(el=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:'V',code:'KeyV',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));const data=new DataTransfer();data.setData('text/plain','a\tb\n1\t2');data.setData('text/html','<table><tr><td><b>rich</b></td></tr></table>');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});assert.equal(await page.locator('#editor table,#editor b').count(),0);assert((await page.locator('#editor').textContent()).includes('a'));
   await press('Meta+p');assert(await page.evaluate(()=>messages.some(m=>m.type==='print')));await press('Meta+/');assert.equal(await page.locator('#dialog-title').textContent(),'笔记快捷键');assert.equal(await page.locator('.shortcut-help>div').count(),36);await press('Escape');
  });
  await t.test('table shortcut, Tab navigation and auto-added row undo',async()=>{
   await reset('<p></p>');await press('Meta+Alt+t');await page.locator('#dialog-body input').nth(0).fill('1');await page.locator('#dialog-body input').nth(1).fill('2');await page.getByRole('button',{name:'插入',exact:true}).click();await select('#editor th:first-child',true);
   await press('Tab');assert.equal(await page.evaluate(()=>getSelection().anchorNode.parentElement.closest('th,td')?.cellIndex??getSelection().anchorNode.cellIndex),1);await press('Shift+Tab');await press('Tab');await press('Tab');assert.equal(await page.locator('#editor tr').count(),2);assert.equal(await page.locator('#editor table table').count(),0);await reset('<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>');await select('#editor td:last-child',true);await press('Tab');assert.equal(await page.locator('#editor tr').count(),2);await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('#editor tr').count(),1);
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
