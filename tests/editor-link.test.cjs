const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const html=require('./editor-fixture.cjs')();

for(const [name,type]of [['Chromium',chromium],['WebKit',webkit]])test(`${name}: pasted link titles`,async()=>{
 const executablePath=name==='Chromium'?process.env.CNOTE_CHROMIUM_EXECUTABLE:process.env.CNOTE_WEBKIT_EXECUTABLE;
 const browser=await type.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<script>window.messages=[];window.ipc={postMessage:s=>messages.push(JSON.parse(s))};</script>'+html);
  const load=id=>page.evaluate(id=>{cnote.receive({type:'load',id,title:id,html:'<p>Before:</p>'});cnote.focusEditor();const s=getSelection();s.selectAllChildren(document.querySelector('#editor p'));s.collapseToEnd();},id);
  const paste=(plain,rich='')=>page.evaluate(({plain,rich})=>{
   const data=new DataTransfer();data.setData('text/plain',plain);if(rich)data.setData('text/html',rich);
   document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  },{plain,rich});
  const request=()=>page.evaluate(()=>messages.filter(m=>m.type==='link_metadata').at(-1));
  const result=(token,title)=>page.evaluate(({token,title})=>cnote.receive({type:'link_metadata_result',token,title}),{token,title});
  const url='https://example.com/article?a=1&b=2';
  await load('titles');await paste(url,'<a href="https://example.com">Clipboard label</a>');
  assert.equal(await page.locator('#editor a').textContent(),url);
  const first=await request();assert.equal(first.url,url);
  await result(first.token,'中文 & <script>标题</script>');
  assert.equal(await page.locator('#editor a').textContent(),'中文 & <script>标题</script>');
  assert.equal(await page.locator('#editor a').getAttribute('href'),url);
  assert.equal(await page.locator('#editor script').count(),0);
  await page.evaluate(()=>cnote.flush());
  assert((await page.evaluate(()=>messages.filter(m=>m.type==='change').at(-1).html)).includes('&lt;script&gt;'));
  await page.evaluate(()=>document.execCommand('undo'));
  assert(!(await page.locator('#editor').textContent()).includes('中文 &'));
  assert((await page.locator('#editor').textContent()).startsWith('Before:'));

  // A delayed title must preserve text and the caret outside the link.
  await load('typing');await paste(url);const typing=await request();
  await page.evaluate(()=>{const r=document.createRange();r.setStartAfter(document.querySelector('#editor a'));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);});
  await page.keyboard.type(' trailing');await result(typing.token,'Article title');await page.keyboard.type('!');
  assert.equal((await page.locator('#editor').textContent()).replaceAll('\u00a0',' '),'Before:Article title trailing!');

  // Results wait for their own note to receive focus, never editing another note.
  await load('origin');await paste(url);const switched=await request();
  await load('other');await result(switched.token,'Original title');
  assert.equal(await page.locator('#editor').textContent(),'Before:');
  await page.evaluate(()=>{cnote.action('open',{id:'origin'});cnote.focusEditor();});
  await page.waitForFunction(()=>document.querySelector('#editor a')?.textContent==='Original title');

  await load('deleted');await paste(url);const deleted=await request();
  await page.evaluate(()=>{document.execCommand('undo');});
  const afterUndo=await page.locator('#editor').innerHTML();await result(deleted.token,'Must not return');
  assert.equal(await page.locator('#editor').innerHTML(),afterUndo);

  await load('edited');await paste(url);const edited=await request();
  await page.evaluate(()=>{document.querySelector('#editor a').textContent='My label';});
  await result(edited.token,'Remote label');assert.equal(await page.locator('#editor a').textContent(),'My label');

  await load('failed');await paste(url);const failed=await request();await result(failed.token,'');
  assert.equal(await page.locator('#editor a').textContent(),url);
  const count=await page.evaluate(()=>messages.filter(m=>m.type==='link_metadata').length);
  await load('plain');await page.evaluate(()=>cnote.formatShortcut('pastePlain'));await paste(url);
  assert.equal(await page.locator('#editor a').count(),0);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='link_metadata').length),count);
  await paste('ordinary text');await paste('Label','<b>Rich text</b>');
  assert.equal(await page.locator('#editor b').textContent(),'Rich text');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='link_metadata').length),count);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
