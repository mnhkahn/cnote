const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright'),html=require('./editor-fixture.cjs')();
for(const [name,type] of [['Chromium',chromium],['WebKit',webkit]])test(name+' automatic homework review',async()=>{
 const browser=await type.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<script>
  window.messages=[];window.cards=[
   {id:'math',name:'口算练习20题',desc:'类型：普通作业\\n作业内容：完成练习册',idList:'todo'},
   {id:'words',name:'单词听写',desc:'作业类型：背单词\\n背单词：bus stop, camera（相机）, post(office)',idList:'todo'},
   {id:'reading',name:'阅读',desc:'作业类型：阅读英语\\n英语原文：\\nHello there.\\nWe read together.\\n英语译文：你好',idList:'todo'},
   {id:'legacy',name:'英语阅读链接',desc:'作业类型：阅读英语\\n阅读英语链接：/ai/translate?textbook=0&article=1',idList:'todo'},
   {id:'missing',name:'口算缺少附件',desc:'',idList:'todo'},
   {id:'comprehension',name:'语文阅读理解',desc:'类型：普通作业\\n作业内容：回答课后问题',idList:'todo'},
   {id:'multi',name:'口算两图',desc:'作业类型：口算',idList:'todo'},
   {id:'history',name:'已批改单词听写',desc:'作业类型：背单词\\n背单词：bus stop, camera',idList:'todo'}
  ];cards.forEach(c=>c.due=new Date().toISOString());
  window.ipc={postMessage(raw){const m=JSON.parse(raw);messages.push(m);if(m.type==='workspace')cnoteTools.show(m.index);if(m.type==='tool_ready')setTimeout(()=>cnoteTools.receive({type:'tool_state',state:{trelloBoard:'board'}}),0);if(m.type!=='trello')return;
  if(m.op==='manual_homework_review'){window.manualRequest=m;return;}
  if(m.op==='review_homework'){window.reviewRequest=m;return;}if(m.op==='publish_homework'){window.publishRequest=m;return;}
  const c=cards.find(c=>c.id===m.id);const data=m.op==='status'?{connected:true}:m.op==='boards'?{boards:[{id:'board',name:'Board'}]}:m.op==='board'?{lists:[{id:'todo',name:'待完成'}],cards}:m.op==='reading_source'?{reference:'From textbook.\\nSecond line.'}:m.op==='card'?{card:c,homework_review:c.id==='comprehension'?window.manualSaved:undefined,attachments:c.id==='missing'?[]:c.id==='multi'?[{id:'previous',name:'page_00000000-0000-0000-0000-000000000001.jpg',mimeType:'image/jpeg',date:'2026-01-01'},{id:'page2',name:'page_00000000-0000-0000-0000-000000000002.jpg',mimeType:'image/jpeg',date:'2026-02-02'},{id:'page1',name:'page_00000000-0000-0000-0000-000000000002.jpg',mimeType:'image/jpeg',date:'2026-02-01'}]:[{id:'old',name:'old.png',mimeType:'image/png',isUpload:true,date:'2026-01-01'},{id:'latest',name:'latest.png',mimeType:'image/png',isUpload:true,date:'2026-02-01'},{id:'audio',name:'reading.m4a',mimeType:'audio/mp4',isUpload:true}],actions:c.id==='comprehension'&&window.manualAction?[window.manualAction]:c.id==='math'&&window.publishedAction?[window.publishedAction]:c.id==='history'?[{id:'action-review',type:'commentCard',date:'2026-11-16T10:00:00Z',data:{text:'作业批改：\\n'+JSON.stringify({version:1,type:'text',review_id:'private-review-id',grade:'良',provisional:false,has_errors:true,text:'打分结果：良\\n正确 1 · 需订正 1 / 共 2 项\\n第1题：正确。正确\\n第2题：需订正。请重新听写。'})}}]:[]}:{mime:'text/plain',base64:'aGk='};setTimeout(()=>cnoteTrello.receive({request:m.request,data}),0);}};
  </script>`+html);
  await page.keyboard.press('Meta+5');
  const open=async title=>{await page.getByRole('button',{name:title,exact:true}).click();await page.locator('.trello-homework-review').waitFor();};
  const close=async()=>page.locator('#trello-detail').getByRole('button',{name:'关闭',exact:true}).click();
  await open('口算练习20题');assert.equal(await page.locator('.trello-homework-review input,.trello-homework-review textarea,.trello-homework-review select').count(),0);
  await page.getByRole('button',{name:'开始自动阅卷'}).click();
  assert.deepEqual(await page.evaluate(()=>[reviewRequest.kind,reviewRequest.attachment,Object.hasOwn(reviewRequest,'count')]),['arithmetic','latest',false]);
  assert(await page.getByRole('button',{name:'开始自动阅卷'}).isDisabled());
  await page.evaluate(()=>cnoteTrello.receive({request:reviewRequest.request,error:'服务忙'}));await page.getByText('阅卷失败：服务忙',{exact:true}).waitFor();
  await page.getByRole('button',{name:'开始自动阅卷'}).click();
  await page.evaluate(()=>cnoteTrello.receive({request:reviewRequest.request,data:{published:false,review_id:'review-math',publication_error:'写入失败',input:{kind:'arithmetic'},report:{grade:'优',correct:19,incorrect:1,pending:0,total:20,accuracy:95,items:[{number:2,status:'correct',raw:'correct-row-should-be-hidden',hint:'正确'},{number:1,expression:'2+2',raw:'<img src=x>',status:'incorrect',hint:'请重新计算'}]}}}));
  await page.getByText('阅卷完成，保存失败：写入失败',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'开始自动阅卷'}).isDisabled());assert.equal(await page.locator('.trello-homework-review table,.trello-homework-result').count(),0);assert(!(await page.locator('.trello-homework-review').textContent()).includes('correct-row-should-be-hidden'));
  await page.getByRole('button',{name:'重试保存结果'}).click();assert.equal(await page.evaluate(()=>publishRequest.review_id),'review-math');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='review_homework').length),2);
  await page.evaluate(()=>{
   window.publishedAction={id:'published-math-action',type:'commentCard',date:new Date().toISOString(),data:{text:'作业批改：\n'+JSON.stringify({version:1,type:'text',grade:'优',has_errors:true,text:'正确 19 · 需订正 1 / 共 20 项\n第1题：请重新计算。'})}};
   cnoteTrello.receive({request:publishRequest.request,data:{published:true,review_id:'review-math',card:{id:'math',idList:'fix',desc:'打分结果：优\n类型：普通作业\n作业内容：完成练习册',dueComplete:false},input:{kind:'arithmetic'},report:{grade:'优',correct:19,incorrect:1,pending:0,total:20,accuracy:95,items:[]}}});
  });
  await page.getByText('★ 本次评分 · 优',{exact:true}).waitFor();
  await page.getByText('阅卷结果已保存到 Trello',{exact:true}).waitFor();assert.match(await page.locator('.trello-card-status').textContent(),/待改错/);assert.match(await page.locator('.trello-description').textContent(),/打分结果：优/);
  assert.equal(await page.locator('.trello-homework-result').count(),0);assert(!(await page.locator('.trello-homework-review').textContent()).includes('正确 19'));
  await close();await open('口算练习20题');await page.getByText('阅卷结果已保存到 Trello',{exact:true}).waitFor();assert.equal(await page.locator('.trello-homework-result').count(),0);await close();
  await open('口算两图');await page.getByRole('button',{name:'开始自动阅卷'}).click();assert.deepEqual(await page.evaluate(()=>reviewRequest.attachments),['page1','page2']);assert.equal(await page.evaluate(()=>Object.hasOwn(reviewRequest,'count')),false);await close();
  await open('单词听写');assert.equal(await page.locator('.trello-homework-review textarea,.trello-homework-review select').count(),0);
  await page.getByRole('button',{name:'开始自动阅卷'}).click();assert.equal(await page.evaluate(()=>reviewRequest.kind),'dictation');assert.equal(await page.evaluate(()=>reviewRequest.words),'bus stop\ncamera\npost office');
  await page.evaluate(()=>cnoteTrello.receive({request:reviewRequest.request,data:{published:true,input:{kind:'dictation',words:['hungry','ice cream','lemonade']},report:{grade:'差',provisional:true,correct:1,incorrect:1,pending:1,total:3,items:[{number:1,raw:'e-reder game console',state:'uncertain',status:'pending'},{number:2,raw:'ice cream',state:'clear',status:'correct'},{number:3,raw:'temud',state:'clear',status:'incorrect'}]}}}));
  await page.getByText('阅卷结果已保存到 Trello',{exact:true}).waitFor();assert.equal(await page.locator('.trello-homework-review pre,.trello-homework-review table').count(),0);assert(!(await page.locator('.trello-homework-review').textContent()).includes('temud'));await close();
  await open('阅读');assert.equal(await page.locator('.trello-homework-review textarea').count(),0);await page.getByRole('button',{name:'开始自动阅卷'}).click();assert.deepEqual(await page.evaluate(()=>[reviewRequest.reference,reviewRequest.attachment]),['Hello there.\nWe read together.','audio']);
  await page.evaluate(()=>cnoteTrello.receive({request:reviewRequest.request,data:{input:{kind:'reading',transcript:'Hello there'},report:{grade:'良',reference_score:75,matched:3,substituted:1,focus:[{word:'together',count:3}],practice_url:'https://www.cyeam.com/ai/translate?words=together'}}}));
  await page.getByText('阅卷结果尚未确认保存，请重新打开卡片核对。',{exact:true}).waitFor();assert(!(await page.locator('.trello-homework-review').textContent()).includes('Hello there'));assert(!(await page.locator('.trello-homework-review').textContent()).includes('together'));await close();
  await open('英语阅读链接');await page.waitForFunction(()=>!document.querySelector('.trello-homework-review button.primary').disabled);await page.getByRole('button',{name:'开始自动阅卷'}).click();assert.equal(await page.evaluate(()=>reviewRequest.reference),'From textbook.\nSecond line.');await close();
  await open('口算缺少附件');assert(await page.getByRole('button',{name:'开始自动阅卷'}).isDisabled());await page.getByText('暂无作业图片，请先提交作业。',{exact:true}).waitFor();await close();
  await open('已批改单词听写');await page.getByText('✓ 本次评分 · 良',{exact:true}).waitFor();await page.getByText('本次批改有错，请查看订正要求',{exact:true}).waitFor();await page.getByText('最新批改 · 11月16日 18:00',{exact:true}).waitFor();const content=await page.locator('#trello-detail').textContent();assert(!content.includes('private-review-id'));assert(!content.includes('正确。正确'));assert(content.includes('第2题：需订正。请重新听写。'));assert.equal(await page.locator('.trello-review-entry').count(),1);await page.getByRole('button',{name:'刷新批改'}).click();await page.getByText('✓ 本次评分 · 良',{exact:true}).waitFor();assert(!content.includes('has_errors'));assert(!content.includes('作业批改：'));assert(!content.includes('attachment_id'));assert.equal(await page.locator('.trello-homework-review input,.trello-homework-review textarea,.trello-homework-review select').count(),0);await close();await page.getByRole('button',{name:'语文阅读理解',exact:true}).click();await page.locator('.trello-description').waitFor();assert.equal(await page.locator('.trello-homework-review').count(),0);

  const manual=page.locator('.trello-manual-review');
  await manual.locator('summary').click();
  await manual.getByLabel('评分',{exact:true}).selectOption('良');
  await manual.getByRole('button',{name:'提交批改',exact:true}).click();
  await manual.getByText('请填写错题和订正要求',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='manual_homework_review').length),0);
  const feedback='第2题：请补上理由。\n第4题：请重新读题。';
  await manual.getByLabel('批改说明').fill(feedback);
  await manual.getByRole('button',{name:'提交批改',exact:true}).click();
  assert(await manual.getByRole('button',{name:'提交批改',exact:true}).isDisabled());
  assert.deepEqual(await page.evaluate(()=>[manualRequest.id,manualRequest.grade,manualRequest.feedback]),['comprehension','良',feedback]);
  await page.evaluate(feedback=>{
   window.manualSaved={published:false,review_id:'manual-review-id',publication_error:'回写失败',input:{kind:'manual'},report:{grade:'良',feedback}};
   cnoteTrello.receive({request:manualRequest.request,data:manualSaved});
  },feedback);
  await manual.getByText('批改保存失败：回写失败',{exact:true}).waitFor();
  await close();await page.getByRole('button',{name:'语文阅读理解',exact:true}).click();
  await manual.getByRole('button',{name:'重试保存结果',exact:true}).click();
  assert.equal(await page.evaluate(()=>publishRequest.review_id),'manual-review-id');
  await page.evaluate(feedback=>{
   window.manualAction={id:'manual-action',type:'commentCard',date:new Date().toISOString(),data:{text:'作业批改：\n'+JSON.stringify({version:1,type:'text',grade:'良',has_errors:true,text:feedback})}};
   window.manualSaved={...manualSaved,published:true,card:{id:'comprehension',idList:'fix',dueComplete:false,desc:'打分结果：良\n类型：普通作业\n作业内容：回答课后问题'}};
   cnoteTrello.receive({request:publishRequest.request,data:manualSaved});
  },feedback);
  await manual.getByText('批改已提交到 Trello',{exact:true}).waitFor();
  await page.locator('.trello-review-text').waitFor();
  assert.equal(await page.locator('.trello-review-text').textContent(),feedback);
  assert.match(await page.locator('.trello-card-status').textContent(),/待改错/);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='manual_homework_review').length),1);
 }finally{await browser.close();}
});
