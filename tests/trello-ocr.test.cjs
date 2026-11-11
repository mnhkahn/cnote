const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright'),html=require('./editor-fixture.cjs')();
const png=require('node:fs').readFileSync(require('node:path').join(__dirname,'ocr-text.png')).toString('base64');
for(const [name,type] of [['Chromium',chromium],['WebKit',webkit]])test(name+' image OCR',async()=>{
 const browser=await type.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<script>window.messages=[];window.ipc={postMessage(raw){const m=JSON.parse(raw);messages.push(m);if(m.type==='workspace')cnoteTools.show(m.index);if(m.type==='tool_ready')setTimeout(()=>cnoteTools.receive({type:'tool_state',state:{trelloBoard:'board'}}),0);if(m.type!=='trello')return;if(m.op==='recognize_image'){window.ocrRequest=m.request;return;}const data=m.op==='status'?{connected:true}:m.op==='boards'?{boards:[{id:'board',name:'Board'}]}:m.op==='board'?{lists:[{id:'todo',name:'待完成'}],cards:[{id:'card',name:'OCR test',idList:'todo',due:new Date().toISOString()}]}:m.op==='card'?{card:{id:'card',name:'OCR test'},attachments:[{id:'image',name:'test.png',mimeType:'image/png',isUpload:true}],actions:[]}:{mime:'image/png',base64:'${png}'};setTimeout(()=>cnoteTrello.receive({request:m.request,data}),0);}};</script>`+html);
  await page.keyboard.press('Meta+5');await page.getByRole('button',{name:'OCR test',exact:true}).click();
  const icon=page.getByRole('button',{name:'识别图片文字',exact:true});await icon.click();
  assert(await icon.isDisabled());assert.equal(await icon.textContent(),'');
  assert.notEqual(await icon.locator('i').evaluate(el=>getComputedStyle(el,'::before').content),'none');
  await page.evaluate(()=>cnoteTrello.receive({request:ocrRequest,error:'识别超时'}));await page.getByText('识别失败：识别超时',{exact:true}).waitFor();
  await icon.click();await page.evaluate(()=>cnoteTrello.receive({request:ocrRequest,data:{text:'Hello <img src=x>\n你好'}}));
  await page.locator('.trello-image-transcript pre').waitFor();assert.equal(await page.locator('.trello-image-transcript pre').textContent(),'Hello <img src=x>\n你好');assert.equal(await page.locator('.trello-image-transcript img').count(),0);
  await page.getByRole('button',{name:'放大图片：test.png'}).click();
  const viewer=page.locator('#trello-image-viewer');await viewer.getByRole('button',{name:'识别图片文字'}).click();
  await page.evaluate(()=>cnoteTrello.receive({request:ocrRequest,data:{text:'Viewer OCR'}}));await viewer.getByText('Viewer OCR',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='recognize_image').length),3);
  await viewer.getByRole('button',{name:'关闭图片'}).click();assert.equal(await viewer.count(),0);
 }finally{await browser.close();}
});
