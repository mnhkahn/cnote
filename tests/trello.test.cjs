const {test}=require('node:test'),assert=require('node:assert/strict');
const png=require('node:fs').readFileSync(require('node:path').join(__dirname,'../assets/note.png')).toString('base64');
const wav=Buffer.alloc(124);wav.write('RIFF');wav.writeUInt32LE(116,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(80,40);
const {chromium,webkit}=require('playwright'),html=require('./editor-fixture.cjs')();
for(const [name,type] of [['Chromium',chromium],['WebKit',webkit]])test(name+' Trello weekly planner',async()=>{
 const browser=await type.launch({headless:true});
 try{const context=await browser.newContext({timezoneId:'Asia/Shanghai',viewport:{width:1000,height:740}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-11-01T10:00:00+08:00')});
 const fixture=`<script>
 window.messages=[];window.failImageOnce=true;window.revoked=[];window.nativeRevoke=window.nativeRevoke||URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);nativeRevoke(url);};window.failBoards=false;window.boardFailureCode='auth_required';window.ipc={postMessage(raw){const m=JSON.parse(raw);messages.push(m);if(m.type==='workspace')cnoteTools.show(m.index);if(m.type==='refresh_workspace'){if(cnoteTools.workspace===4)cnoteTrello.refresh();else cnote.action('refresh');}if(m.type==='tool_ready')setTimeout(()=>cnoteTools.receive({type:'tool_state',state:{}}),0);if(m.type==='tool_save')setTimeout(()=>cnoteTools.receive({type:'tool_saved',seq:m.seq}),0);if(m.type==='trello')setTimeout(()=>{
 if(m.op==='update_cell'){
 if(window.failUpdate){cnoteTrello.receive({request:m.request,error:'没有权限修改，请重新授权读写权限'});return;}
 cnoteTrello.receive({request:m.request,data:{card:m.field==='progress'?{id:m.id,idList:m.value,dueComplete:m.value==='done'}:{id:m.id,desc:m.value?'打分结果：'+m.value:''}}});return;}
 if(m.op==='copy_image'){cnoteTrello.receive({request:m.request,data:{copied:true}});return;}
 if(m.op==='share_image'){cnoteTrello.receive({request:m.request,data:{shared:!!m.image}});return;}
 if(m.op==='transcribe_audio'){window.pendingASR=m.request;return;}
 if(m.op==='download'||m.op==='download_audio'){window.pendingDownload=m.request;return;}
 if(m.op==='attachment'){
 if(m.attachment==='image'&&failImageOnce){failImageOnce=false;cnoteTrello.receive({request:m.request,error:'模拟附件加载失败'});return;}
 const data=m.attachment==='image'?{mime:'image/png',base64:'${png}'}:m.attachment==='audio'?{mime:'audio/wav',base64:'${wav.toString('base64')}'}:{mime:'text/plain',base64:'${Buffer.from('附件正文 <img src=x onerror=alert(1)>').toString('base64')}'};cnoteTrello.receive({request:m.request,data});return;}
 const card={id:'card',name:'练习 <img src=x>',desc:'类型：普通作业\\n完整描述\\n作业：[打开练习](https://example.com/practice?a=1&b=2)\\n参考：https://example.org/page_(one)。\\n<https://example.net/help>\\n[危险链接](javascript:alert(1))',idList:'todo',due:'2026-10-31T16:30:00Z',dueComplete:false,url:'https://trello.com/c/example',members:[{fullName:'成员甲'}],checklists:[{name:'练习步骤',checkItems:[{name:'第一步 https://example.net/step',state:'complete'}]}]};
 const data=m.op==='status'?{connected:true,key:'a'.repeat(32)}:m.op==='authorize'?{url:'https://trello.com/1/authorize?scope=read,write'}:m.op==='connect'?{connected:true}:m.op==='disconnect'?{connected:false}:m.op==='boards'?{boards:[{id:'board',name:'学习看板'}]}:m.op==='board'?{lists:[{id:'todo',name:'待完成'},{id:'done',name:'已完成'}],cards:window.testCards||[{...card,id:'donecard',idList:'done',name:'已完成任务',dateCompleted:'2026-11-01T03:00:00Z',dateLastActivity:'2026-11-01T03:00:00Z',desc:'打分结果：暂评·良\\n其他说明',dueComplete:false},{...card,id:'missingtime',idList:'done',name:'无完成记录任务',desc:''},{...card,id:'earlydone',idList:'done',name:'早完成任务',dateCompleted:'2026-11-01T01:00:00Z',dateLastActivity:'2026-11-01T05:00:00Z',desc:'打分结果：100\\n作业类型：口算'},card,{...card,id:'past',name:'昨天任务',due:'2026-10-31T02:00:00Z'},{...card,id:'none',due:null},{...card,id:'closed',closed:true}]}:{card,attachments:[{id:'image',name:'附件图片',mimeType:'image/png',isUpload:true,date:'2026-11-01T01:00:00Z',url:'https://trello.com/file'},{id:'audio',name:'音频作业',mimeType:'audio/wav',isUpload:true,date:'2026-11-01T03:00:00Z',url:'https://trello.com/audio'},{id:'text',name:'文字附件',mimeType:'text/plain',isUpload:true,date:'2026-11-01T02:00:00Z',url:'https://trello.com/text'}],actions:[{type:'commentCard',date:'2026-11-01T01:00:00Z',memberCreator:{fullName:'作者'},data:{text:'完整评论 <img src=x onerror=alert(1)> [反馈](https://example.net/feedback)'}}]};cnoteTrello.receive({request:m.request,...(failBoards&&m.op==='boards'?{error:boardFailureCode==='auth_required'?'请先授权 Trello':'网络暂时不可用',code:boardFailureCode}:{data})});},5);}};
 </script>`+html;await page.setContent(fixture);
 await page.keyboard.press('Meta+5');await page.waitForSelector('#trello-board option[value="board"]',{state:'attached'});
 assert.equal(await page.locator('.trello-day[aria-pressed=true]').getAttribute('aria-label'),'2026-11-01');assert.equal(await page.locator('.trello-day').first().getAttribute('aria-label'),'2026-10-26');
 await page.selectOption('#trello-board','board');await page.waitForSelector('.trello-task');assert.equal(await page.locator('.trello-task').count(),4);assert.equal(await page.locator('.trello-table').count(),1);assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','作业类型','进度','打分结果','实际完成时间','预计完成时间','更新时间']);assert.deepEqual(await page.locator('.trello-task .trello-progress').allTextContents(),['待完成','已完成','已完成','已完成']);assert.deepEqual(await page.locator('.trello-task .trello-grade').allTextContents(),['—','100','暂评·良','—']);assert.deepEqual(await page.locator('.trello-homework-type').allTextContents(),['普通作业','口算','—','—']);assert.equal(await page.locator('.trello-task img').count(),0);assert.deepEqual(await page.locator('.trello-open-card').allTextContents(),['练习 <img src=x>','早完成任务','已完成任务','无完成记录任务']);assert.deepEqual(await page.locator('.trello-completed-at').allTextContents(),['—','2026-11-01 09:00','2026-11-01 11:00','—']);assert.deepEqual(await page.locator('.trello-updated-at').allTextContents(),['—','2026-11-01 13:00','2026-11-01 11:00','—']);
 const editableRow=()=>page.locator('.trello-task').filter({has:page.getByRole('button',{name:'练习 <img src=x>',exact:true})});
 await editableRow().locator('.trello-progress').dblclick();
 assert(await page.getByRole('listbox',{name:'修改进度'}).isVisible(),'double-click opens the options immediately');
 assert.equal(await page.locator('#trello-detail').count(),0);
 assert.deepEqual(await page.getByLabel('修改进度',{exact:true}).getByRole('option').allTextContents(),['待完成','已完成']);
 const editingReads=await page.evaluate(()=>messages.filter(m=>m.op==='board').length);await page.clock.runFor(60020);
 assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='board').length),editingReads);
 await page.getByRole('option',{name:'已完成',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.trello-cell-options'));
 assert.equal(await editableRow().locator('.trello-progress').textContent(),'已完成');
 assert.deepEqual(await page.evaluate(()=>{const {id,field,value}=messages.find(m=>m.op==='update_cell');return {id,field,value};}),{id:'card',field:'progress',value:'done'});
 await editableRow().locator('.trello-grade').dblclick();
 assert.deepEqual(await page.getByLabel('修改打分结果',{exact:true}).getByRole('option').allTextContents(),['未评分','100','优','良','中','差']);
 {
  await page.getByRole('option',{name:'100',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.trello-cell-options'));
  assert.equal(await editableRow().locator('.trello-grade').textContent(),'100');
  assert.equal(await page.locator('#trello-message').textContent(),'已保存到 Trello');
  assert.deepEqual(await page.evaluate(()=>{const {field,value}=messages.filter(m=>m.op==='update_cell').at(-1);return {field,value};}),{field:'grade',value:'100'});
  await editableRow().locator('.trello-grade').dblclick();
 }
 await page.getByRole('option',{name:'优',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.trello-cell-options'));
 assert.equal(await editableRow().locator('.trello-grade').textContent(),'优');
 const writes=await page.evaluate(()=>messages.filter(m=>m.op==='update_cell').length);
 await editableRow().locator('.trello-grade').dblclick();await page.keyboard.press('Escape');
 assert.equal(await editableRow().locator('.trello-grade').textContent(),'优');
 await editableRow().locator('.trello-grade').press('Enter');await page.locator('.trello-header h1').click();
 assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='update_cell').length),writes);
 await page.evaluate(()=>window.failUpdate=true);await editableRow().locator('.trello-grade').dblclick();
 await page.getByRole('option',{name:'差',exact:true}).click();await page.waitForFunction(()=>document.getElementById('trello-message').textContent.includes('重新授权读写权限'));
 assert.equal(await editableRow().locator('.trello-grade').textContent(),'优');
 await page.evaluate(()=>window.failUpdate=false);await editableRow().locator('.trello-grade').dblclick();
 await page.getByRole('option',{name:'未评分',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.trello-cell-options'));
 assert.equal(await editableRow().locator('.trello-grade').textContent(),'—');
 const beforeRefresh=await page.evaluate(()=>messages.filter(m=>m.type==='trello'&&m.op==='board').length);await page.locator('#trello-board').focus();await page.keyboard.press('Meta+r');await page.waitForFunction(n=>messages.filter(m=>m.type==='trello'&&m.op==='board').length===n+1,beforeRefresh);await page.waitForSelector('.trello-task');assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='refresh').length),0);
 await page.keyboard.press('Meta+1');await page.keyboard.press('Meta+r');await page.waitForFunction(()=>messages.some(m=>m.type==='refresh'));assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='trello'&&m.op==='board').length),beforeRefresh+1);await page.keyboard.press('Meta+5');
 const reads=()=>page.evaluate(()=>messages.filter(m=>m.type==='trello'&&m.op==='board').length);
 const beforeAuto=await reads();await page.clock.runFor(60020);await page.waitForFunction(n=>messages.filter(m=>m.type==='trello'&&m.op==='board').length===n+1,beforeAuto);await page.waitForSelector('.trello-task');
 await page.locator('.trello-task').first().locator('.trello-open-card').click();await page.waitForSelector('.trello-description');const detailReads=await reads();await page.clock.runFor(60020);assert.equal(await reads(),detailReads);assert(await page.locator('#trello-detail').isVisible());await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('#trello-settings').click();await page.clock.runFor(60020);assert.equal(await reads(),detailReads);assert((await page.locator('.trello-guide').textContent()).includes('自动保持连接'));await page.getByRole('button',{name:'返回看板',exact:true}).click();await page.waitForSelector('.trello-task');
 await page.keyboard.press('Meta+1');const pausedReads=await reads();await page.clock.runFor(120020);assert.equal(await reads(),pausedReads);await page.keyboard.press('Meta+5');await page.clock.runFor(20);await page.waitForFunction(n=>messages.filter(m=>m.type==='trello'&&m.op==='board').length===n+1,pausedReads);await page.waitForSelector('.trello-task');
 await page.evaluate(()=>{const task=(id,idList,hour,completed)=>({id,name:id,idList,due:`2026-11-01T${String(hour).padStart(2,'0')}:00:00Z`,dateCompleted:completed||null});window.testCards=[task('待完成较晚','todo',4),task('同完成较晚预计','done',3,'2026-11-01T02:00:00Z'),task('无实际时间','done',0),task('实际更早','done',15,'2026-11-01T01:00:00Z'),task('待完成较早','todo',2),task('同完成较早预计','done',1,'2026-11-01T02:00:00Z')];});await page.locator('#trello-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.trello-task').length===6);assert.deepEqual(await page.locator('.trello-open-card').allTextContents(),['待完成较早','待完成较晚','实际更早','同完成较早预计','同完成较晚预计','无实际时间']);assert.deepEqual(await page.locator('.trello-due-at').allTextContents(),['2026-11-01 10:00','2026-11-01 12:00','2026-11-01 23:00','2026-11-01 09:00','2026-11-01 11:00','2026-11-01 08:00']);await page.screenshot({path:'/tmp/cnote-trello-sorting-'+name+'.png'});
 assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','进度','打分结果','实际完成时间','预计完成时间','更新时间']);
 await page.evaluate(()=>{testCards[0].desc='类型：   \n打分结果：中';});await page.locator('#trello-refresh').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.trello-grade')].some(cell=>cell.textContent==='中'));
 assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','进度','打分结果','实际完成时间','预计完成时间','更新时间']);
 await page.evaluate(()=>{testCards[0].desc='作业类型：阅读\n打分结果：   \n其他说明';});await page.locator('#trello-refresh').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.trello-homework-type')].some(cell=>cell.textContent==='阅读'));
 assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','作业类型','进度','打分结果','实际完成时间','预计完成时间','更新时间']);

 await page.evaluate(()=>{delete window.testCards;failImageOnce=true;});await page.locator('#trello-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.trello-task').length===4);
 await page.locator('.trello-task').first().locator('.trello-open-card').click();await page.waitForSelector('.trello-description');assert.equal(await page.locator('.trello-description').textContent(),'类型：普通作业\n完整描述\n作业：打开练习\n参考：https://example.org/page_(one)。\nhttps://example.net/help\n[危险链接](javascript:alert(1))');assert((await page.locator('.trello-action').textContent()).includes('完整评论'));assert.equal(await page.locator('.trello-action').isVisible(),false);await page.locator('.trello-activity summary').click();assert(await page.locator('.trello-action').isVisible());assert.equal(await page.locator('.trello-action p').count(),0);const detail=page.locator('#trello-detail');
 assert.deepEqual(await detail.getByRole('link').evaluateAll(links=>links.map(link=>link.href)),[
  'https://example.com/practice?a=1&b=2','https://example.org/page_(one)','https://example.net/help',
  'https://example.net/step','https://example.net/feedback',
 ]);
 await detail.getByRole('link',{name:'打开练习',exact:true}).click();
 await detail.getByRole('link',{name:'反馈',exact:true}).press('Enter');
 assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='link').map(m=>m.url)),[
  'https://example.com/practice?a=1&b=2','https://example.net/feedback',
 ]);
 assert(await detail.isVisible());
 await page.evaluate(()=>{window.messages=messages.filter(m=>m.type!=='link');});
 await page.locator('.trello-activity').screenshot({path:'/tmp/cnote-trello-activity-'+name+'.png'});await page.locator('.trello-activity summary').click();assert.equal(await page.locator('.trello-action').isVisible(),false);assert((await page.locator('.trello-detail-body').textContent()).includes('成员甲'));assert((await page.locator('.trello-detail-body').textContent()).includes('☑ 第一步'));assert.equal(await page.locator('#trello-detail script').count(),0);assert.deepEqual(await page.locator('.trello-attachment-preview figcaption strong').allTextContents(),['音频作业','文字附件','附件图片']);await page.waitForSelector('.trello-attachment-content audio');assert(await page.locator('.trello-attachment-content audio').evaluate(el=>el.controls));await page.waitForFunction(()=>document.querySelector('.trello-attachment-content pre')?.textContent.includes('附件正文'));assert.equal(await page.locator('.trello-attachment-content pre img').count(),0);await page.getByRole('button',{name:'重试加载',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.trello-attachment-content img')?.naturalWidth>0);assert.equal(await page.locator('.trello-attachment-content img').count(),1);await page.locator('.trello-attachment-preview').last().screenshot({path:'/tmp/cnote-trello-attachment-'+name+'.png'});assert(await page.locator('.trello-image-thumb img').evaluate(img=>img.getBoundingClientRect().height<=150&&img.getBoundingClientRect().width<=220));assert.equal(await page.locator('.trello-image-tile figcaption button').count(),0);
 const audioDownload=page.getByRole('button',{name:'Download audio',exact:true});
 assert.equal(await audioDownload.textContent(),'');assert.equal(await audioDownload.locator('.bi-download').count(),1);
 assert.equal(await audioDownload.evaluate(el=>el.previousElementSibling.getAttribute('aria-label')),'ASR 转文本');
 const asr=page.getByRole('button',{name:'ASR 转文本',exact:true});
 await asr.click();await page.waitForFunction(()=>window.pendingASR);assert(await asr.isDisabled());
 assert.deepEqual(await page.evaluate(()=>{const {id,attachment}=messages.find(m=>m.op==='transcribe_audio');return {id,attachment};}),{id:'card',attachment:'audio'});
 await page.evaluate(()=>cnoteTrello.receive({request:pendingASR,error:'语音识别超时'}));await page.waitForFunction(()=>document.querySelector('.trello-audio-transcript').textContent.includes('语音识别超时'));assert(await asr.isEnabled());
 await asr.click();await page.waitForFunction(()=>messages.filter(m=>m.op==='transcribe_audio').length===2&&pendingASR===messages.filter(m=>m.op==='transcribe_audio').at(-1).request);
 await page.evaluate(()=>cnoteTrello.receive({request:pendingASR,data:{text:'hello <img src=x onerror=alert(1)>'}}));await page.waitForFunction(()=>document.querySelector('.trello-audio-transcript pre'));
 assert.equal(await page.locator('.trello-audio-transcript pre').textContent(),'hello <img src=x onerror=alert(1)>');assert.equal(await page.locator('.trello-audio-transcript img').count(),0);assert(await asr.isEnabled());
 assert.equal(await page.locator('.trello-open-attachment').evaluateAll(buttons=>buttons.every(button=>!button.textContent.trim()&&button.title==='打开原附件'&&button.querySelector('.bi-box-arrow-up-right'))),true);
 await audioDownload.click();await page.waitForFunction(()=>window.pendingDownload===messages.filter(m=>m.op==='download_audio').at(-1)?.request);
 assert(await audioDownload.isDisabled());
 assert.deepEqual(await page.evaluate(()=>{const {id,attachment,name}=messages.find(m=>m.op==='download_audio');return {id,attachment,name};}),{id:'card',attachment:'audio',name:'音频作业'});
 await page.evaluate(()=>cnoteTrello.receive({request:pendingDownload,data:{saved:false}}));await page.waitForFunction(()=>!document.querySelector('.trello-audio-download').disabled);
 await audioDownload.click();await page.waitForFunction(()=>messages.filter(m=>m.op==='download_audio').length===2&&window.pendingDownload===messages.filter(m=>m.op==='download_audio').at(-1).request);
 await page.evaluate(()=>cnoteTrello.receive({request:pendingDownload,error:'模拟下载失败'}));await page.waitForFunction(()=>document.getElementById('trello-message').textContent.includes('模拟下载失败'));
 assert(await audioDownload.isEnabled());await audioDownload.click();await page.waitForFunction(()=>messages.filter(m=>m.op==='download_audio').length===3&&window.pendingDownload===messages.filter(m=>m.op==='download_audio').at(-1).request);
 await page.evaluate(()=>{cnoteTrello.receive({request:pendingDownload,data:{saved:true}});window.pendingDownload=null;});await page.waitForFunction(()=>document.getElementById('trello-message').textContent==='音频已保存');
 await page.locator('.trello-attachment-preview').first().screenshot({path:'/tmp/cnote-trello-audio-'+name+'.png'});
 await page.getByRole('button',{name:'放大图片：附件图片',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#trello-image-viewer > span[role=status]')?.textContent.startsWith('原图 ·'));assert(await page.evaluate(()=>messages.some(m=>m.type==='trello'&&m.op==='attachment'&&m.original===true)));const viewerImage=page.locator('.trello-image-stage img');
 await viewerImage.click({button:'right'});
 assert.deepEqual(await page.locator('.trello-image-menu [role=menuitem]').allTextContents(),['复制图片','分享图片','在页面中打开','下载原图']);
 await page.getByRole('menuitem',{name:'分享图片',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#trello-image-viewer > span[role=status]').textContent==='图片已分享');
 await page.getByRole('button',{name:'分享图片',exact:true}).click();
 await page.waitForFunction(()=>messages.filter(m=>m.op==='share_image').length===2);
 assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.op==='share_image').map(({id,attachment,name,image})=>({id,attachment,name,image}))),Array(2).fill({id:'card',attachment:'image',name:'附件图片',image:{mime:'image/png',base64:png}}));
 // Safari 16 on Big Sur has dialogs but no Popover API.
 await page.evaluate(()=>{HTMLElement.prototype.showPopover=undefined;HTMLElement.prototype.hidePopover=undefined;});
 await viewerImage.click({button:'right'});
 await page.getByRole('menuitem',{name:'复制图片',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#trello-image-viewer > span[role=status]').textContent==='图片已复制');
 await viewerImage.click({button:'right'});await page.getByRole('menuitem',{name:'在页面中打开',exact:true}).click();
 assert(await page.evaluate(()=>messages.some(m=>m.type==='link'&&m.url==='https://trello.com/file')));
 await viewerImage.click({button:'right'});await page.getByRole('menuitem',{name:'下载原图',exact:true}).click();
 await page.waitForFunction(()=>window.pendingDownload);
 assert.equal(await page.locator('#trello-image-viewer > span[role=status]').textContent(),'请选择图片保存位置…');
 await page.evaluate(()=>cnoteTrello.receive({request:pendingDownload,progress:'正在下载原图…'}));
 assert.equal(await page.locator('#trello-image-viewer > span[role=status]').textContent(),'正在下载原图…');
 await page.evaluate(()=>cnoteTrello.receive({request:pendingDownload,error:'原图下载超时，请重试'}));
 await page.waitForFunction(()=>document.querySelector('#trello-image-viewer > span[role=status]').textContent.includes('下载失败：原图下载超时'));
 await page.getByRole('button',{name:'原始大小',exact:true}).click();assert(await page.locator('.trello-image-stage img').evaluate(img=>Math.abs(img.getBoundingClientRect().width-img.naturalWidth)<1));await page.getByRole('button',{name:'顺时针旋转',exact:true}).click();assert((await page.locator('.trello-image-stage img').getAttribute('style')).includes('rotate(90deg)'));await page.getByRole('button',{name:'逆时针旋转',exact:true}).click();assert((await page.locator('.trello-image-stage img').getAttribute('style')).includes('rotate(0deg)'));await page.getByRole('button',{name:'逆时针旋转',exact:true}).click();assert((await page.locator('.trello-image-stage img').getAttribute('style')).includes('rotate(270deg)'));await page.getByRole('button',{name:'放大',exact:true}).click();assert.equal(await page.locator('.trello-image-zoom').textContent(),'125%');await page.keyboard.press('-');assert.equal(await page.locator('.trello-image-zoom').textContent(),'100%');await page.keyboard.press('+');assert.equal(await page.locator('.trello-image-zoom').textContent(),'125%');await page.keyboard.press('1');assert.equal(await page.locator('.trello-image-zoom').textContent(),'100%');await page.keyboard.press('r');assert((await page.locator('.trello-image-stage img').getAttribute('style')).includes('rotate(0deg)'));await page.keyboard.press('Shift+r');assert((await page.locator('.trello-image-stage img').getAttribute('style')).includes('rotate(270deg)'));assert.equal(await page.locator('.trello-image-toolbar button').evaluateAll(buttons=>buttons.every(b=>!b.textContent.trim()&&b.getAttribute('aria-label')&&b.title&&b.querySelector('.bi'))),true);await page.keyboard.press('1');for(let i=0;i<5;i++)await page.keyboard.press('+');const panBefore=await page.locator('.trello-image-viewport').evaluate(el=>({x:el.scrollLeft,y:el.scrollTop}));await page.keyboard.press('ArrowRight');assert((await page.locator('.trello-image-viewport').evaluate(el=>el.scrollLeft))>panBefore.x);await page.keyboard.press('ArrowDown');assert((await page.locator('.trello-image-viewport').evaluate(el=>el.scrollTop))>panBefore.y);await page.keyboard.press('0');await page.screenshot({path:'/tmp/cnote-trello-image-viewer-'+name+'.png'});assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='link').length),1);await page.getByRole('button',{name:'关闭图片',exact:true}).click();assert(await page.locator('#trello-detail').isVisible());await page.getByRole('button',{name:'放大图片：附件图片',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#trello-image-viewer > span[role=status]')?.textContent.startsWith('原图 ·'));assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='attachment'&&m.original===true).length),1);await page.keyboard.press('Escape');assert.equal(await page.locator('#trello-image-viewer').count(),0);await page.getByRole('button',{name:'关闭',exact:true}).click();assert((await page.evaluate(()=>revoked.length))>=2);
 await page.locator('[aria-label="2026-10-31"]').click();assert.equal(await page.locator('.trello-task').count(),1);assert.equal(await page.locator('.trello-open-card').textContent(),'昨天任务');
 await page.locator('#trello-next').click();assert.equal(await page.locator('.trello-day[aria-pressed=true]').getAttribute('aria-label'),'2026-11-07');assert.equal(await page.locator('.trello-task').count(),0);await page.locator('#trello-today').click();assert.equal(await page.locator('.trello-task').count(),4);
 assert.equal(await page.evaluate(()=>cnoteTools.state.trelloBoard),'board');await page.screenshot({path:'/tmp/cnote-trello-'+name+'.png'});
 await page.evaluate(()=>{failBoards=true;boardFailureCode='request_failed';document.getElementById('trello-board').value='';document.getElementById('trello-board').dispatchEvent(new Event('change'));});await page.locator('#trello-refresh').click();await page.waitForFunction(()=>document.getElementById('trello-message').textContent.includes('网络暂时不可用'));assert.equal(await page.locator('#trello-token').count(),0);assert(await page.getByRole('button',{name:'重试连接',exact:true}).isVisible());
 await page.evaluate(()=>failBoards=false);await page.getByRole('button',{name:'重试连接',exact:true}).click();await page.waitForFunction(()=>document.getElementById('trello-message').textContent==='');
 await page.locator('#trello-settings').click();assert((await page.locator('.trello-guide').textContent()).includes('自动保持连接'));assert.equal(await page.locator('#trello-token').count(),0);await page.getByRole('button',{name:'返回看板',exact:true}).click();
 await page.evaluate(()=>{failBoards=true;boardFailureCode='auth_required';});await page.locator('#trello-refresh').click();await page.waitForFunction(()=>document.getElementById('trello-content').textContent.includes('请先授权 Trello'));assert(await page.locator('#trello-api-key').isVisible());assert.equal(await page.locator('#trello-token').getAttribute('type'),'password');assert.equal((await page.locator('.trello-guide').textContent()).includes('CLI'),false);
 await page.locator('#trello-api-key').fill('a'.repeat(32));await page.getByRole('button',{name:'打开 Trello 授权页面',exact:true}).click();await page.waitForFunction(()=>messages.some(m=>m.type==='link'&&m.url.includes('scope=read,write')));
 await page.evaluate(()=>failBoards=false);await page.locator('#trello-token').fill('fake-token-for-test');await page.getByRole('button',{name:'关联并保存',exact:true}).click();await page.waitForSelector('#trello-board option[value="board"]',{state:'attached'});await page.waitForSelector('#trello-token',{state:'detached'});assert.equal(JSON.stringify(await page.evaluate(()=>cnoteTools.state)).includes('fake-token-for-test'),false);
 await page.setContent(fixture.replace('state:{}',"state:{trelloBoard:'board'}"));await page.keyboard.press('Meta+5');await page.waitForSelector('.trello-task');assert.equal(await page.locator('#trello-token').count(),0);assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='trello'&&['connect','authorize'].includes(m.op))),false);
 await page.locator('#trello-settings').click();assert.equal(await page.locator('#trello-token').count(),0);await page.getByRole('button',{name:'断开关联',exact:true}).click();await page.waitForFunction(()=>cnoteTools.state.trelloBoard==='');assert.equal(await page.locator('.trello-task').count(),0);assert(await page.locator('#trello-token').isVisible());await page.screenshot({path:'/tmp/cnote-trello-auth-'+name+'.png'});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
