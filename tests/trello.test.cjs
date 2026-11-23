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
 const updates={progress:{idList:m.value,dueComplete:m.value==='done'},grade:{desc:m.value?'打分结果：'+m.value:''},homework_type:{desc:'作业类型：'+m.value},desc:{desc:m.value},start:{start:m.value||null},due:{due:m.value},dateCompleted:{desc:'<!-- cnote dateCompleted='+m.value+' -->\\n作业类型：阅读英语'},dateLastActivity:{desc:'<!-- cnote dateLastActivity='+m.value+' -->\\n作业类型：阅读英语'}};
 cnoteTrello.receive({request:m.request,data:{card:{id:m.id,...updates[m.field]}}});return;}
 if(m.op==='delete_card'){
  if(window.failDelete){cnoteTrello.receive({request:m.request,error:'没有权限删除'});return;}
  window.testCards=testCards.filter(card=>card.id!==m.id);
  cnoteTrello.receive({request:m.request,data:{deleted:true}});return;}
 if(m.op==='copy_image'){cnoteTrello.receive({request:m.request,data:{copied:true}});return;}
 if(m.op==='share_image'){cnoteTrello.receive({request:m.request,data:{shared:!!m.image}});return;}
 if(m.op==='transcribe_audio'){window.pendingASR=m.request;return;}
 if(m.op==='download'||m.op==='download_audio'){window.pendingDownload=m.request;return;}
 if(m.op==='attachment'){
 if(m.attachment==='image-first'&&m.original){window.pendingFirstImage=m.request;return;}
 if(m.attachment==='image'&&failImageOnce){failImageOnce=false;cnoteTrello.receive({request:m.request,error:'模拟附件加载失败'});return;}
 const data=['image','image-first','image-last'].includes(m.attachment)?{mime:'image/png',base64:'${png}'}:m.attachment==='audio'?{mime:'audio/wav',base64:'${wav.toString('base64')}'}:{mime:'text/plain',base64:'${Buffer.from('附件正文 <img src=x onerror=alert(1)>').toString('base64')}'};cnoteTrello.receive({request:m.request,data});return;}
 const card={id:'card',name:'练习 <img src=x>',desc:'类型：普通作业\\n完整描述\\n作业：[打开练习](https://example.com/practice?a=1&b=2)\\n参考：https://example.org/page_(one)。\\n<https://example.net/help>\\n[危险链接](javascript:alert(1))',idList:'todo',due:'2026-10-31T16:30:00Z',dueComplete:false,url:'https://trello.com/c/example',members:[{fullName:'成员甲'}],checklists:[{name:'练习步骤',checkItems:[{name:'第一步 https://example.net/step',state:'complete'}]}]};
 const data=m.op==='status'?{connected:true,key:'a'.repeat(32)}:m.op==='authorize'?{url:'https://trello.com/1/authorize?scope=read,write'}:m.op==='connect'?{connected:true}:m.op==='disconnect'?{connected:false}:m.op==='boards'?{boards:[{id:'board',name:'学习看板'}]}:m.op==='board'?{lists:window.testLists||[{id:'todo',name:'待完成'},{id:'done',name:'已完成'}],cards:window.testCards||[{...card,id:'donecard',idList:'done',name:'已完成任务',start:'2026-10-31T16:20:00Z',dateCompleted:'2026-11-01T03:00:00Z',dateLastActivity:'2026-11-01T03:00:00Z',desc:'打分结果：暂评·良\\n其他说明',dueComplete:false},{...card,id:'missingtime',idList:'done',name:'无完成记录任务',desc:''},{...card,id:'earlydone',idList:'done',name:'早完成任务',start:'2026-10-31T16:15:00Z',dateCompleted:'2026-11-01T01:00:00Z',dateLastActivity:'2026-11-01T05:00:00Z',desc:'打分结果：100\\n作业类型：口算'},card,{...card,id:'past',name:'昨天任务',due:'2026-10-31T02:00:00Z'},{...card,id:'none',due:null},{...card,id:'closed',closed:true}]}:{card:window.testCards?.find(item=>item.id===m.id)||card,attachments:[{id:'image',name:'附件图片',mimeType:'image/png',isUpload:true,date:'2026-11-01T01:00:00Z',url:'https://trello.com/file'},{id:'audio',name:'音频作业',mimeType:'audio/wav',isUpload:true,date:'2026-11-01T03:00:00Z',url:'https://trello.com/audio'},{id:'text',name:'文字附件',mimeType:'text/plain',isUpload:true,date:'2026-11-01T02:00:00Z',url:'https://trello.com/text'},...(window.extraImages?[
 {id:'image-last',name:'最后一张',isUpload:true,date:'2026-11-01T00:00:00Z'},
 {id:'image-first',name:'第一张.png',isUpload:true,date:'2026-11-01T04:00:00Z'}
 ]:[])],actions:[{type:'commentCard',date:'2026-11-01T01:00:00Z',memberCreator:{fullName:'作者'},data:{text:'完整评论 <img src=x onerror=alert(1)> [反馈](https://example.net/feedback)'}}]};cnoteTrello.receive({request:m.request,...(failBoards&&m.op==='boards'?{error:boardFailureCode==='auth_required'?'请先授权 Trello':'网络暂时不可用',code:boardFailureCode}:{data})});},5);}};
 </script>`+html;await page.setContent(fixture);
 await page.keyboard.press('Meta+5');await page.waitForSelector('#trello-board option[value="board"]',{state:'attached'});
 assert.equal(await page.locator('.trello-day[aria-pressed=true]').getAttribute('aria-label'),'2026-11-01');assert.equal(await page.locator('.trello-day').first().getAttribute('aria-label'),'2026-10-26');
 await page.selectOption('#trello-board','board');await page.waitForSelector('.trello-task');assert.equal(await page.locator('.trello-task').count(),4);assert.equal(await page.locator('.trello-table').count(),1);assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','作业类型','进度','打分结果','预计开始时间','实际完成时间','预计完成时间','更新时间','计划用时','实际用时']);assert.deepEqual(await page.locator('.trello-task .trello-progress').allTextContents(),['待完成','已完成','已完成','已完成']);assert.deepEqual(await page.locator('.trello-task .trello-grade').allTextContents(),['—','100','暂评·良','—']);assert.deepEqual(await page.locator('.trello-homework-type').allTextContents(),['普通作业','口算','—','—']);assert.equal(await page.locator('.trello-task img').count(),0);assert.deepEqual(await page.locator('.trello-open-card').allTextContents(),['练习 <img src=x>','早完成任务','已完成任务','无完成记录任务']);assert.deepEqual(await page.locator('.trello-completed-at').allTextContents(),['—','2026-11-01 09:00','2026-11-01 11:00','—']);assert.deepEqual(await page.locator('.trello-updated-at').allTextContents(),['—','2026-11-01 13:00','2026-11-01 11:00','—']);
 const editableRow=()=>page.locator('.trello-task').filter({has:page.getByRole('button',{name:'练习 <img src=x>',exact:true})});
 await editableRow().locator('.trello-progress').dblclick();
 assert(await page.getByRole('listbox',{name:'修改进度'}).isVisible(),'double-click opens the options immediately');
 assert.equal(await page.locator('#trello-detail').count(),0);
 assert.deepEqual(await page.getByLabel('修改进度',{exact:true}).getByRole('option').allTextContents(),['待完成','已完成']);
 const editingReads=await page.evaluate(()=>messages.filter(m=>m.op==='board').length);await page.clock.runFor(300020);
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
 const saveField=async(cls,label,value)=>{
  await editableRow().locator(cls).dblclick();
  const form=page.getByRole('form',{name:'修改'+label,exact:true});
  await form.getByLabel(label,{exact:true}).fill(value);
  await form.getByRole('button',{name:'保存',exact:true}).click();
  await form.waitFor({state:'detached'});
 };
 assert.equal(await editableRow().locator('td.trello-editable').count(),7);
 await editableRow().locator('.trello-homework-type').dblclick();
 const typeForm=page.getByRole('form',{name:'修改作业类型',exact:true});
 const typeSelect=typeForm.getByRole('combobox',{name:'作业类型',exact:true});
 assert.equal(await typeSelect.inputValue(),'');
 assert.deepEqual(await typeSelect.getByRole('option').allTextContents(),['未设置','普通作业','口算','背单词','阅读英语','预习','附件PDF']);
 await typeSelect.selectOption('阅读英语');
 await typeForm.getByRole('button',{name:'保存',exact:true}).click();
 await typeForm.waitFor({state:'detached'});
 assert.equal(await editableRow().locator('.trello-homework-type').textContent(),'阅读英语');
 await saveField('.trello-start-at','预计开始时间','2026-11-01T08:45');
 assert.equal(await editableRow().locator('.trello-start-at').textContent(),'2026-11-01 08:45');
 assert.deepEqual(await page.evaluate(()=>{const {field,value}=messages.filter(m=>m.op==='update_cell').at(-1);return {field,value};}),{field:'start',value:'2026-11-01T00:45:00.000Z'});
 await editableRow().locator('.trello-start-at').dblclick();
 await page.getByRole('form',{name:'修改预计开始时间',exact:true}).getByRole('button',{name:'清除',exact:true}).click();
 await page.getByRole('form',{name:'修改预计开始时间',exact:true}).waitFor({state:'detached'});
 assert.equal(await editableRow().locator('.trello-start-at').textContent(),'—');
 await saveField('.trello-completed-at','实际完成时间','2026-11-01T09:45');
 assert.equal(await editableRow().locator('.trello-completed-at').textContent(),'2026-11-01 09:45');
 await saveField('.trello-updated-at','更新时间','2026-11-01T10:10');
 assert.equal(await editableRow().locator('.trello-updated-at').textContent(),'2026-11-01 10:10');
 await saveField('.trello-due-at','预计完成时间','2026-11-02T08:00');
 assert.equal(await editableRow().count(),0);
 await page.getByRole('button',{name:'下一周',exact:true}).click();
 await page.locator('[aria-label="2026-11-02"]').click();
 assert.equal(await editableRow().locator('.trello-due-at').textContent(),'2026-11-02 08:00');
 await saveField('.trello-due-at','预计完成时间','2026-11-01T08:30');
 await page.locator('#trello-today').click();
 await editableRow().locator('.trello-open-card').click();
 const editDetail=page.locator('#trello-detail');
 await editDetail.getByRole('button',{name:'编辑作业类型',exact:true}).click();
 const detailType=editDetail.getByRole('combobox',{name:'作业类型',exact:true});
 assert.equal(await detailType.inputValue(),'普通作业');
 await detailType.press('Escape');
 await editDetail.getByRole('button',{name:'编辑描述',exact:true}).click();
 const descriptionForm=editDetail.getByRole('form',{name:'修改描述',exact:true});
 assert.match(await descriptionForm.getByLabel('描述',{exact:true}).inputValue(),/完整描述/);
 await descriptionForm.getByLabel('描述',{exact:true}).fill('作业类型：阅读英语\n参考：https://example.com/new');
 await page.evaluate(()=>window.failUpdate=true);
 await descriptionForm.getByRole('button',{name:'保存',exact:true}).click();
 await editDetail.locator('.trello-edit-feedback[data-error=true]').waitFor();
 assert((await descriptionForm.getByLabel('描述',{exact:true}).inputValue()).includes('https://example.com/new'));
 await page.evaluate(()=>window.failUpdate=false);
 await descriptionForm.getByRole('button',{name:'保存',exact:true}).click();
 await descriptionForm.waitFor({state:'detached'});
 assert.equal(await editDetail.getByRole('link',{name:'https://example.com/new',exact:true}).count(),1);
 assert.equal(await editableRow().locator('.trello-homework-type').textContent(),'阅读英语');
 assert.equal(await editDetail.getByRole('button',{name:'编辑标题',exact:true}).count(),0);
 await editDetail.getByRole('button',{name:'关闭',exact:true}).click();
 const beforeRefresh=await page.evaluate(()=>messages.filter(m=>m.type==='trello'&&m.op==='board').length);await page.locator('#trello-board').focus();await page.keyboard.press('Meta+r');await page.waitForFunction(n=>messages.filter(m=>m.type==='trello'&&m.op==='board').length===n+1,beforeRefresh);await page.waitForSelector('.trello-task');assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='refresh').length),0);
 await page.keyboard.press('Meta+1');await page.keyboard.press('Meta+r');await page.waitForFunction(()=>messages.some(m=>m.type==='refresh'));assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='trello'&&m.op==='board').length),beforeRefresh+1);await page.keyboard.press('Meta+5');
 assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='board').at(-1).cache),false);
 const reads=()=>page.evaluate(()=>messages.filter(m=>m.type==='trello'&&m.op==='board').length);
 const cachedReads=await reads();await page.keyboard.press('Meta+1');await page.clock.runFor(60020);await page.keyboard.press('Meta+5');await page.clock.runFor(20);assert.equal(await reads(),cachedReads);
 const beforeAuto=await reads();await page.clock.runFor(300020);await page.waitForFunction(n=>messages.filter(m=>m.type==='trello'&&m.op==='board').length===n+1,beforeAuto);await page.waitForSelector('.trello-task');
 await page.locator('.trello-task').first().locator('.trello-open-card').click();await page.waitForSelector('.trello-description');const detailReads=await reads();await page.clock.runFor(300020);assert.equal(await reads(),detailReads);assert(await page.locator('#trello-detail').isVisible());await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('#trello-settings').click();await page.clock.runFor(300020);assert.equal(await reads(),detailReads);assert((await page.locator('.trello-guide').textContent()).includes('自动保持连接'));await page.getByRole('button',{name:'返回看板',exact:true}).click();await page.waitForSelector('.trello-task');
 await page.keyboard.press('Meta+1');const pausedReads=await reads();await page.clock.runFor(600020);assert.equal(await reads(),pausedReads);await page.keyboard.press('Meta+5');await page.clock.runFor(20);await page.waitForFunction(n=>messages.filter(m=>m.type==='trello'&&m.op==='board').length===n+1,pausedReads);await page.waitForSelector('.trello-task');
 await page.evaluate(()=>{const task=(id,idList,hour,completed,start)=>({id,name:id,idList,start,due:`2026-11-01T${String(hour).padStart(2,'0')}:00:00Z`,dateCompleted:completed||null});window.testCards=[task('待完成较晚','todo',4,null,'2026-11-01T00:30:00Z'),task('同完成较晚预计','done',3,'2026-11-01T02:00:00Z','2026-11-01T00:40:00Z'),task('无实际时间','done',0),task('实际更早','done',15,'2026-11-01T01:00:00Z'),task('待完成较早','todo',2),task('同完成较早预计','done',1,'2026-11-01T02:00:00Z','2026-11-01T00:40:00Z')];});await page.locator('#trello-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.trello-task').length===6);assert.deepEqual(await page.locator('.trello-open-card').allTextContents(),['待完成较晚','待完成较早','无实际时间','同完成较早预计','同完成较晚预计','实际更早']);assert.deepEqual(await page.locator('.trello-due-at').allTextContents(),['2026-11-01 12:00','2026-11-01 10:00','2026-11-01 08:00','2026-11-01 09:00','2026-11-01 11:00','2026-11-01 23:00']);await page.screenshot({path:'/tmp/cnote-trello-sorting-'+name+'.png'});
 assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','作业类型','进度','打分结果','预计开始时间','实际完成时间','预计完成时间','更新时间','计划用时','实际用时']);
 await page.evaluate(()=>{testCards[0].desc='类型：   \n打分结果：中';});await page.locator('#trello-refresh').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.trello-grade')].some(cell=>cell.textContent==='中'));
 assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','作业类型','进度','打分结果','预计开始时间','实际完成时间','预计完成时间','更新时间','计划用时','实际用时']);
 await page.evaluate(()=>{testCards[0].desc='作业类型：阅读\n打分结果：   \n其他说明';});await page.locator('#trello-refresh').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.trello-homework-type')].some(cell=>cell.textContent==='阅读'));
 assert.deepEqual(await page.locator('.trello-table th').allTextContents(),['标题','作业类型','进度','打分结果','预计开始时间','实际完成时间','预计完成时间','更新时间','计划用时','实际用时']);

 await page.evaluate(()=>{
  window.testLists=[{id:'todo',name:'待完成'},{id:'fix',name:'待改错'},{id:'done',name:'已完成'}];
  const event=(time,correction=false)=>({at:Date.parse('2026-11-01T'+time+'Z')/1000,correction});
  testCards[0].homeworkStarted=event('02:15:00');
  testCards[1].homeworkStarted=event('05:00:00');
  testCards[4].start='2026-11-01T01:00:00Z';
  Object.assign(testCards[1],{desc:'预计用时：10 分钟\r\n作业类型：普通作业',homeworkDurationSeconds:601});
  Object.assign(testCards[2],{desc:'预计用时: 5',homeworkDurationSeconds:299});
  Object.assign(testCards[3],{desc:'预计用时: 20',homeworkDurationSeconds:1200});
  Object.assign(testCards[5],{homeworkDurationSeconds:60});
  testCards.push(
   {id:'fixing',name:'开始订正',idList:'fix',start:'2026-11-01T01:30:00Z',due:'2026-11-01T05:00:00Z',homeworkStarted:event('03:10:00',true)},
   {id:'old',name:'等待订正',idList:'fix',due:'2026-11-01T05:00:00Z',homeworkStarted:event('04:20:00')}
  );
 });
 await page.locator('#trello-refresh').click();
 await page.waitForFunction(()=>document.querySelectorAll('.trello-started-time').length===2);
 assert.deepEqual((await page.locator('.trello-open-card').allTextContents()).slice(0,5),['待完成较晚','待完成较早','开始订正','等待订正','无实际时间']);
 assert.deepEqual(await page.locator('.trello-started-time').allTextContents(),['11-01 10:15','11-01 11:10']);
 const rowNamed=name=>page.getByRole('row').filter({has:page.getByRole('button',{name,exact:true})});
 assert.equal(await rowNamed('同完成较晚预计').locator('.trello-start-at').textContent(),'2026-11-01 08:40');
 assert.equal(await rowNamed('无实际时间').locator('.trello-start-at').textContent(),'2026-11-01 07:55');
 assert.equal(await rowNamed('无实际时间').locator('.trello-planned-duration').textContent(),'5 分钟');
 assert.equal(await rowNamed('等待订正').locator('.trello-planned-duration').textContent(),'—');
 assert.equal(await rowNamed('等待订正').locator('.trello-actual-duration').textContent(),'—');
 const over=rowNamed('同完成较晚预计').locator('.trello-actual-duration');
 assert.equal(await over.textContent(),'10 分钟 1 秒');
 assert.equal(await over.getAttribute('data-duration-status'),'over');
 assert.equal(await over.evaluate(el=>getComputedStyle(el).fontWeight),'700');
 const under=rowNamed('无实际时间').locator('.trello-actual-duration');
 assert.equal(await under.textContent(),'4 分钟 59 秒');
 assert.equal(await under.getAttribute('data-duration-status'),'under');
 assert.equal(await rowNamed('实际更早').locator('.trello-actual-duration').getAttribute('data-duration-status'),'');
 assert.equal(await rowNamed('同完成较早预计').locator('.trello-actual-duration').getAttribute('data-duration-status'),'');
 assert.equal(await page.locator('.trello-table tbody tr:not(.trello-task)').count(),0);
 await page.getByRole('button',{name:'开始订正',exact:true}).click();
 assert.match(await page.locator('.trello-card-status').textContent(),/已开始 · 实际开始 2026-11-01 11:10/);
 await page.getByRole('button',{name:'关闭',exact:true}).click();

 await page.evaluate(()=>{delete window.testCards;delete window.testLists;failImageOnce=true;});await page.locator('#trello-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.trello-task').length===4);
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
 assert.equal(await page.getByRole('button',{name:'上一张',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'下一张',exact:true}).count(),0);
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
 await page.evaluate(()=>window.extraImages=true);
 await editableRow().locator('.trello-open-card').click();
 await page.setViewportSize({width:390,height:740});
 const imageThumbs=page.locator('.trello-image-thumb');
 await imageThumbs.nth(2).waitFor();
 assert.deepEqual(await imageThumbs.evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label'))),[
  '放大图片：第一张.png','放大图片：附件图片','放大图片：最后一张'
 ]);
 await imageThumbs.nth(1).click();
 const previous=page.getByRole('button',{name:'上一张',exact:true}),next=page.getByRole('button',{name:'下一张',exact:true});
 assert(await previous.isEnabled());
 assert(await next.isEnabled());
 await previous.click();
 assert.equal(await viewerImage.getAttribute('alt'),'第一张.png');
 assert(await previous.isDisabled());
 assert(await next.isEnabled());
 await page.waitForFunction(()=>window.pendingFirstImage);
 await next.click();
 assert.equal(await viewerImage.getAttribute('alt'),'附件图片');
 await next.click();
 assert.equal(await viewerImage.getAttribute('alt'),'最后一张');
 assert(await next.isDisabled());
 assert(await previous.isEnabled());
 await page.evaluate(base64=>cnoteTrello.receive({request:pendingFirstImage,data:{mime:'image/png',base64}}),png);
 await page.waitForFunction(()=>document.querySelector('#trello-image-viewer > span[role=status]')?.textContent.startsWith('原图 ·'));
 assert.equal(await viewerImage.getAttribute('alt'),'最后一张');
 await previous.click();
 assert.equal(await viewerImage.getAttribute('alt'),'附件图片');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.setViewportSize({width:1000,height:740});
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
 await page.evaluate(()=>{window.testCards=[{id:'delete-me',name:'待删除作业',idList:'todo',due:'2026-11-01T02:00:00Z'},{id:'keep-me',name:'保留作业',idList:'todo',due:'2026-11-01T03:00:00Z'}];});
 await page.locator('#trello-refresh').click();
 const toDelete=page.getByRole('button',{name:'待删除作业',exact:true});
 const openDelete=async()=>{
  await toDelete.click({button:'right'});
  await page.getByRole('menuitem',{name:'删除作业',exact:true}).click();
  return page.getByRole('dialog',{name:'删除作业',exact:true});
 };
 const cancelled=await openDelete();
 assert.match(await cancelled.textContent(),/待删除作业/);
 await cancelled.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='delete_card').length),0);
 assert(await toDelete.isVisible());
 await page.evaluate(()=>window.failDelete=true);
 const confirmation=await openDelete();
 const confirm=confirmation.getByRole('button',{name:'确认删除',exact:true});
 await confirm.click();
 await confirmation.getByText('删除失败：没有权限删除',{exact:true}).waitFor();
 assert.equal(await page.locator('.trello-open-card').filter({hasText:'待删除作业'}).count(),1);
 await page.evaluate(()=>window.failDelete=false);
 await confirm.click();
 await toDelete.waitFor({state:'detached'});
 assert.equal(await page.locator('#trello-message').textContent(),'作业已删除');
 assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.op==='delete_card').map(m=>m.id)),['delete-me','delete-me']);
 await page.locator('#trello-refresh').click();
 await page.getByRole('button',{name:'保留作业',exact:true}).waitFor();
 assert.equal(await toDelete.count(),0);
 await page.evaluate(()=>{
  window.testLists=[{id:'todo',name:'待完成'},{id:'fix',name:'待改错'}];
  window.testCards=[
   {id:'words',name:'背单词',idList:'fix',due:'2026-11-01T08:15:00Z',dateCompleted:null,
    desc:'预计 15 分钟；当日第 2 项；16:00–16:15（北京时间）。',
    homeworkCompletedAt:'2026-11-01T09:38:29Z',homeworkDurationSeconds:3729},
   {id:'preview',name:'预习',idList:'todo',due:'2026-11-01T11:15:00Z',
    desc:'预计用时: 15 分钟；当日第 5 项；18:50–19:15（北京时间）。'},
   {id:'later',name:'小练笔',idList:'todo',due:'2026-11-01T12:40:00Z',
    desc:'预计用时: 15 分钟；当晚第 10 项；预计 20:20–20:40（北京时间）。'},
   {id:'fallback',name:'纯预计用时',idList:'todo',due:'2026-11-01T09:15:00Z',
    desc:'预计用时: 20 分钟；当日第 3 项。'},
   {id:'school',name:'按学校安排',idList:'todo',due:'2026-11-01T01:00:00Z',
    desc:'完成地点：学校。开始时间以学校早读安排为准。'},
  ];
 });
 await page.locator('#trello-refresh').click();
 const scheduleRow=title=>page.getByRole('row').filter({has:page.getByRole('button',{name:title,exact:true})});
 await scheduleRow('背单词').waitFor();
 assert.equal(await scheduleRow('背单词').locator('.trello-start-at').textContent(),'2026-11-01 16:00');
 assert.equal(await scheduleRow('背单词').locator('.trello-completed-at').textContent(),'2026-11-01 17:38');
 assert.equal(await scheduleRow('背单词').locator('.trello-planned-duration').textContent(),'15 分钟');
 assert.equal(await scheduleRow('背单词').locator('.trello-actual-duration').textContent(),'62 分钟 9 秒');
 assert.equal(await scheduleRow('预习').locator('.trello-start-at').textContent(),'2026-11-01 18:50');
 assert.equal(await scheduleRow('小练笔').locator('.trello-start-at').textContent(),'2026-11-01 20:20');
 assert.equal(await scheduleRow('纯预计用时').locator('.trello-start-at').textContent(),'2026-11-01 16:55');
 assert.equal(await scheduleRow('按学校安排').locator('.trello-start-at').textContent(),'—');
 await page.locator('#trello-settings').click();assert.equal(await page.locator('#trello-token').count(),0);await page.getByRole('button',{name:'断开关联',exact:true}).click();await page.waitForFunction(()=>cnoteTools.state.trelloBoard==='');assert.equal(await page.locator('.trello-task').count(),0);assert(await page.locator('#trello-token').isVisible());await page.screenshot({path:'/tmp/cnote-trello-auth-'+name+'.png'});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
