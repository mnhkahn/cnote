'use strict';
(() => {
 const root=document.getElementById('trello-tool');
 let selected=new Date(),boards=[],lists=[],cards=[],board='',loaded=false,busy=false,serial=0,boardEpoch=0,detailEpoch=0,connected=false,apiKey='',downloadingHomework=false;
 const pending=new Map(),mediaUrls=new Set(),originalImages=new Map(),originalData=new Map();
 let imageViewer=null,autoTimer=null,active=false,lastRefreshAt=0;
 let sharingImage=false,editingCell=null;
 let microsoftAccount='',accountEpoch=0,linkDialog=null,linkChecking=false,linkDismissed=false,linkConfirmed=false,linkSupported=false;
 function closeAccountLink(){if(linkDialog){linkDialog.close();linkDialog.remove();linkDialog=null;}}
 function account(authenticated,id){
  const next=authenticated&&id?String(id):'';if(next===microsoftAccount)return;
  const previous=microsoftAccount;microsoftAccount=next;accountEpoch++;linkChecking=false;linkDismissed=false;linkConfirmed=false;linkSupported=false;closeAccountLink();
  if(previous||loaded){boardEpoch++;detailEpoch++;stopAutoRefresh();removeDetail();connected=false;board='';boards=[];lists=[];cards=[];loaded=false;root.replaceChildren();if(active)window.cnoteTrello.show();}
  if(next)checkAccountLink();
 }
 async function checkAccountLink(manual=false){
  if(!microsoftAccount||linkChecking||linkDialog||(!manual&&(linkDismissed||linkConfirmed)))return;
  const epoch=accountEpoch;linkChecking=true;
  try{
   const state=await request('status');if(epoch!==accountEpoch)return;linkSupported=!!state.account_linking;if(!linkSupported||state.account_id!==microsoftAccount)return;
   if(state.cloud_available===false){if(manual||active)message(state.connection_error||'作业账号同步服务暂不可用',true);return;}if(state.linked){linkConfirmed=true;if(state.connected&&state.board&&(!connected||board!==state.board)){connected=true;board=state.board;window.cnoteTools?.setTrelloBoard(board);if(active&&loaded)loadBoards();}return;}if(!state.connected)return;
   const data=await request('link_status',undefined,{account_id:microsoftAccount});if(epoch!==accountEpoch||data.linked)return;
   const dialog=node('dialog',null,'trello-account-link');linkDialog=dialog;
   dialog.append(node('h2','将作业连接保存到微软账号？'),node('p','授权和所选看板会加密保存到 CNote 服务端。其他设备登录同一个微软账号后，自动恢复作业连接。'),node('p',`微软账号：${data.account_name||microsoftAccount}`),node('p',`作业账号：${data.member?.fullName||data.member?.username||'Trello'}`));
   const label=node('label','作业看板'),select=node('select');select.id='trello-link-board';label.htmlFor=select.id;
   select.append(new Option('请选择作业看板',''));for(const item of data.boards||[])if(!item.closed)select.append(new Option(item.name,item.id));
   const preferred=board||window.cnoteTools?.state?.trelloBoard||'';if([...select.options].some(o=>o.value===preferred))select.value=preferred;
   if(!select.value&&select.options.length===2)select.selectedIndex=1;
   const feedback=node('p');feedback.setAttribute('role','status');
   const later=button('稍后',()=>{linkDismissed=true;closeAccountLink();});
   const confirm=button('关联并继续',async()=>{
    if(!select.value){feedback.textContent='请选择作业看板';return;}
    confirm.disabled=true;later.disabled=true;select.disabled=true;feedback.textContent='正在验证并关联…';
    try{const result=await request('link_account',select.value,{account_id:microsoftAccount,member_id:data.member.id});if(epoch!==accountEpoch)return;linkConfirmed=true;board=result.board;window.cnoteTools?.setTrelloBoard(board);closeAccountLink();if(active&&loaded)await loadBoards();}
    catch(error){if(epoch===accountEpoch)feedback.textContent=error.code==='auth_required'?'作业授权已失效，请到关联设置中重新授权。':error.message;}
    finally{confirm.disabled=false;later.disabled=false;select.disabled=false;}
   },'primary');
   dialog.addEventListener('cancel',event=>{event.preventDefault();if(!confirm.disabled){linkDismissed=true;closeAccountLink();}});
   dialog.append(label,select,feedback,later,confirm);document.body.append(dialog);dialog.showModal();
  }catch(error){if(epoch===accountEpoch&&manual)message(error.message,true);}
  finally{if(epoch===accountEpoch)linkChecking=false;}
 }
 const AUTO_REFRESH_MS=60000;
 const dayKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 const dueDay=card=>card.due&&Number.isFinite(new Date(card.due).getTime())?dayKey(new Date(card.due)):'';
 function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;}
 function button(text,action,cls){const el=node('button',text,cls);el.type='button';el.onclick=action;return el;}
 function request(op,id,extra={},progress){return new Promise((resolve,reject)=>{const request=++serial;pending.set(request,{resolve,reject,progress});window.ipc.postMessage(JSON.stringify({type:microsoftAccount&&['status','link_status','link_account','link_board','disconnect'].includes(op)?'trello_connection':'trello',request,op,id,account_id:microsoftAccount,...extra}));});}
 function receive(event){const item=pending.get(event.request);if(!item)return;if(event.progress){item.progress?.(event.progress);return;}pending.delete(event.request);event.error?item.reject(Object.assign(Error(event.error),{code:event.code})):item.resolve(event.data);}
 function message(text,error=false){const el=document.getElementById('trello-message');if(el){el.textContent=text;el.dataset.error=String(error);}}
 const readOnly=()=>window.cnotePlatform?.web===true;
 function guide(error,settings=false,reauthorize=false){
  const panel=document.getElementById('trello-content');panel.replaceChildren();const box=node('div',null,'trello-guide');
  box.append(node('h2',connected?'Trello 关联设置':'关联你的 Trello 看板'),node('p',error||'连接 Trello 后，在这里按截止日期查看每天的卡片进度。'));
  if(connected&&!reauthorize){
   if(settings){box.append(node('p','已关联 · 自动保持连接'),node('p',readOnly()?'此标签页会保留 Trello 授权。':window.cnotePlatform?.mobile?'凭据已保存到系统安全存储。重启 CNote 会自动恢复，无需重复输入。':'凭据已保存到系统钥匙串。重启 CNote 会自动恢复，无需重复输入。'),button('返回看板',()=>loadBoards()),button('更换账号或重新授权',()=>guide('',true,true)));if(linkSupported&&microsoftAccount&&!linkConfirmed)box.append(button('保存作业连接到账号',()=>checkAccountLink(true)));}
   else box.append(button('重新加载看板',()=>loadBoards()),button('关联设置',()=>guide('',true)));
   addDisconnect(box);panel.append(box);return;
  }
  const form=node('form');form.id='trello-connect-form';
  const key=node('input');key.id='trello-api-key';key.value=apiKey;key.autocomplete='off';key.spellcheck=false;key.placeholder='Trello API Key';key.required=true;
  const token=node('input');token.id='trello-token';token.type='password';token.autocomplete='off';token.placeholder='粘贴授权页面显示的 Token';token.required=true;
  const keyLabel=node('label','API Key');keyLabel.htmlFor=key.id;const tokenLabel=node('label','Token');tokenLabel.htmlFor=token.id;
  const feedback=node('p');feedback.id='trello-auth-feedback';feedback.setAttribute('role','status');
  const auth=button('打开 Trello 授权页面',async()=>{auth.disabled=true;feedback.textContent='正在打开授权页面…';try{if(readOnly()){openLink(window.cnoteTools.trelloAuthorization(key.value.trim()));feedback.textContent='允许只读访问后，将页面显示的 Token 粘贴到下方。';return;}const result=await request('authorize',undefined,{key:key.value.trim()});openLink(result.url);feedback.textContent='在浏览器中允许读写访问，再将页面显示的 Token 粘贴到下方。';}catch(error){feedback.textContent=error.message;}finally{auth.disabled=false;}});
  const submit=button('关联并保存');submit.type='submit';submit.className='primary';
  form.append(node('p','首次连接时，可在 Trello 登录页选择“使用 Microsoft 登录”，使用拥有作业看板的原账号。'),node('p','1. 填写 Trello API Key，再打开浏览器授权。'),keyLabel,key,auth,button('获取 API Key',()=>openLink('https://trello.com/apps/admin')),node('p','2. 授权后，将浏览器显示的 Token 粘贴到这里。'),tokenLabel,token,node('p',readOnly()?'使用只读授权，关闭此标签页后需要重新关联。':'只需关联一次：使用长期读写授权，凭据保存在系统钥匙串，重启后自动连接。'),submit,feedback);
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;auth.disabled=true;feedback.textContent='正在验证并关联…';try{await request('connect',undefined,{key:key.value.trim(),token:token.value.trim()});apiKey=key.value.trim();token.value='';connected=true;board='';lists=[];cards=[];detailEpoch++;removeDetail();document.getElementById('trello-board').replaceChildren(new Option('选择看板…',''));window.cnoteTools.setTrelloBoard('');render();linkConfirmed=false;linkDismissed=false;await loadBoards();checkAccountLink();}catch(error){feedback.textContent=error.message;}finally{submit.disabled=false;auth.disabled=false;}};
  box.append(form);
  if(connected)addDisconnect(box);
  panel.append(box);
 }
 function addDisconnect(box){
  const disconnect=button(microsoftAccount?'移除云端作业连接':'断开关联',async()=>{disconnect.disabled=true;try{await request('disconnect');linkConfirmed=false;linkDismissed=true;closeAccountLink();boardEpoch++;detailEpoch++;removeDetail();connected=false;board='';boards=[];lists=[];cards=[];window.cnoteTools.setTrelloBoard('');document.getElementById('trello-board').replaceChildren(new Option('选择看板…',''));render();guide();}catch(error){message(error.message,true);}finally{disconnect.disabled=false;}});box.append(disconnect);
 }
 function failure(error,retry){
  if(error.code==='auth_required'){guide(error.message,true,true);message('需要重新授权 Trello',true);return;}
  message(error.message,true);
  const panel=document.getElementById('trello-content');
  if(!panel.querySelector('.trello-table'))panel.replaceChildren(node('p','连接暂时不可用，已保存的关联信息会保留。','trello-empty'),button('重试连接',()=>retry()));
 }
 function restore(){const epoch=accountEpoch;request('status').then(data=>{if(epoch!==accountEpoch)return;connected=data.connected;apiKey=data.key||'';if(data.account_linking&&data.linked&&data.board)board=data.board;if(connected){loadBoards();checkAccountLink();}else guide();}).catch(error=>{if(epoch===accountEpoch)failure(error,restore);});}
 function webURL(url){
  try{
   const parsed=new URL(url);
   if(parsed.protocol==='https:'||parsed.protocol==='http:')return parsed.href;
  }catch{}
 }
 function openLink(url){const href=webURL(url);if(!href)return;if(readOnly())window.open(href,'_blank','noopener,noreferrer');else window.ipc.postMessage(JSON.stringify({type:'link',url:href}));}
 function linkedText(tag,text,cls){
  const el=node(tag,null,cls);
  const links=/\[([^\]\r\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)\)|<(https?:\/\/[^\s<>]+)>|\b(https?:\/\/(?:[^\s<>()\[\]"'`，。！？；：（）【】《》、]|\([^\s<>()]*\)|\[[0-9a-f:.]+\])+)/gi;
  let end=0;
  for(const match of text.matchAll(links)){
   const [,label,markdown,autolink,bare]=match;
   const url=markdown||autolink||bare.replace(/[.,!?;:]+$/,'');
   const href=webURL(url);
   if(!href)continue;
   el.append(text.slice(end,match.index));
   const link=node('a',label||url);
   link.href=href;
   link.onclick=event=>{event.preventDefault();openLink(link.href);};
   el.append(link);
   end=match.index+match[0].length-(bare?bare.length-url.length:0);
  }
  el.append(text.slice(end));
  return el;
 }
 function shell(){root.innerHTML='<div class="trello-header"><div><div class="trello-eyebrow">TRELLO / WEEKLY PLANNER</div><h1>每一天，都有进展</h1></div><div class="trello-controls"><select id="trello-board" aria-label="选择 Trello 看板"></select><button id="trello-refresh" type="button" title="刷新 Trello（⌘R）" aria-keyshortcuts="Meta+R">刷新</button><div class="trello-settings-actions"><button id="trello-settings" type="button">关联设置</button><button id="trello-download-homework" type="button" title="下载当前选中日期所有作业的图片和音频">下载作业</button></div></div></div><div class="trello-nav"><div><button id="trello-prev" aria-label="上一周">‹</button><button id="trello-today">今天</button><button id="trello-next" aria-label="下一周">›</button></div><strong id="trello-range"></strong><span title="查看卡片详情时暂缓刷新">按截止日期 · 每分钟自动刷新</span></div><div id="trello-week" aria-label="周历"></div><div id="trello-message" role="status"></div><div id="trello-content"></div>';
  const download=document.getElementById('trello-download-homework');
  if(readOnly()){download.remove();root.querySelector('.trello-header h1').textContent='作业';root.querySelector('.trello-eyebrow').remove();}
  else download.onclick=downloadHomework;
  document.getElementById('trello-settings').onclick=()=>{boardEpoch++;busy=false;guide('',true);};
  document.getElementById('trello-prev').onclick=()=>shift(-7);document.getElementById('trello-next').onclick=()=>shift(7);document.getElementById('trello-today').onclick=()=>{selected=new Date();render();};document.getElementById('trello-refresh').onclick=refresh;document.getElementById('trello-board').onchange=async e=>{const next=e.target.value,epoch=accountEpoch;try{if(linkConfirmed&&next)await request('link_board',next,{account_id:microsoftAccount});if(epoch!==accountEpoch)return;lists=[];cards=[];board=next;window.cnoteTools.setTrelloBoard(board);loadBoard();}catch(error){if(epoch===accountEpoch){e.target.value=board;message(error.message,true);}}};
 }
 function refresh(){if(!loaded||busy||editingCell)return;if(microsoftAccount)restore();else if(connected){if(board)loadBoard();else loadBoards();}else restore();}
 function stopAutoRefresh(){clearTimeout(autoTimer);autoTimer=null;}
 function scheduleAutoRefresh(delay=AUTO_REFRESH_MS){
  stopAutoRefresh();if(!active||document.hidden||!connected||!board)return;
  autoTimer=setTimeout(()=>{autoTimer=null;if(!busy&&!editingCell&&!root.querySelector('dialog[open]')&&document.getElementById('trello-content')?.querySelector('.trello-table'))loadBoard(true);else scheduleAutoRefresh();},delay);
 }
 function resumeAutoRefresh(){scheduleAutoRefresh(Math.max(0,AUTO_REFRESH_MS-(Date.now()-lastRefreshAt)));}
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAutoRefresh();else if(active&&loaded)resumeAutoRefresh();});
 function shift(days){selected.setDate(selected.getDate()+days);render();}
 function render(){
  updateHomeworkDownload();
  const first=new Date(selected);first.setDate(first.getDate()-(first.getDay()+6)%7);const last=new Date(first);last.setDate(last.getDate()+6);
  document.getElementById('trello-range').textContent=`${first.getFullYear()}年 ${first.getMonth()+1}月${first.getDate()}日 — ${last.getMonth()+1}月${last.getDate()}日`;
  const week=document.getElementById('trello-week');week.replaceChildren();
  for(let i=0;i<7;i++){const date=new Date(first);date.setDate(date.getDate()+i);const key=dayKey(date),count=cards.filter(c=>!c.closed&&dueDay(c)===key).length;const el=button('',()=>{selected=date;render();},'trello-day');el.setAttribute('aria-label',key);el.setAttribute('aria-pressed',String(key===dayKey(selected)));el.classList.toggle('is-today',key===dayKey(new Date()));el.append(node('span',['周一','周二','周三','周四','周五','周六','周日'][i]),node('strong',String(date.getDate())),node('small',count?`${count} 张卡片`:'—'));week.append(el);}
  if(!board)return;
  const content=document.getElementById('trello-content');content.replaceChildren();if(busy){content.append(node('p','正在加载看板…','trello-empty'));return;}
  const daily=cards.filter(c=>!c.closed&&dueDay(c)===dayKey(selected));
  const listName=card=>lists.find(list=>list.id===card.idList)?.name||'未知进度';
  const rank=card=>{const name=listName(card).trim();if(name==='待完成')return 0;if(name==='待改错')return 1;if(name==='已完成')return 3;if(name==='已改错')return 4;return card.dueComplete?3:2;};
  const homeworkType=card=>String(card.desc||'').match(/^[ \t]*(?:作业)?类型[ \t]*[:：][ \t]*([^\r\n]*)/m)?.[1].trim()||'';
  const grade=card=>String(card.desc||'').match(/^[ \t]*打分结果[ \t]*[:：][ \t]*([^\r\n]*)/m)?.[1].trim()||'';
  const timestamp=value=>{const time=value?Date.parse(value):NaN;return Number.isFinite(time)?time:Number.MAX_SAFE_INTEGER;};
  const completedAt=card=>timestamp(card.dateCompleted);
  const timeText=value=>{value=timestamp(value);if(value===Number.MAX_SAFE_INTEGER)return '—';const date=new Date(value);return `${dayKey(date)} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;};
  const table=node('table',null,'trello-table');table.setAttribute('aria-label','当天 Trello 任务');
  const columns=[
   daily.some(card=>homeworkType(card))&&{label:'作业类型',value:homeworkType,cls:'trello-homework-type',width:10},
   {label:'进度',value:listName,cls:'trello-progress',width:8},
   {label:'打分结果',value:grade,cls:'trello-grade',width:7},
   {label:'实际完成时间',value:card=>timeText(card.dateCompleted),cls:'trello-completed-at',width:17},
   {label:'预计完成时间',value:card=>timeText(card.due),cls:'trello-due-at',width:17},
   {label:'更新时间',value:card=>timeText(card.dateLastActivity),cls:'trello-updated-at',width:17}
  ].filter(Boolean);
  const head=node('thead'),heading=node('tr');for(const column of [{label:'标题',width:100-columns.reduce((sum,column)=>sum+column.width,0)},...columns]){const cell=node('th',column.label);cell.scope='col';cell.style.width=column.width+'%';heading.append(cell);}head.append(heading);table.append(head);
  const body=node('tbody');for(const card of daily.sort((a,b)=>rank(a)-rank(b)||listName(a).localeCompare(listName(b),'zh-CN')||completedAt(a)-completedAt(b)||timestamp(a.due)-timestamp(b.due))){
   const row=node('tr',null,'trello-task');row.dataset.completed=String(rank(card)>=3);
   const titleCell=node('td');titleCell.append(button(card.name,()=>showDetail(card),'trello-open-card'));
   row.append(titleCell);for(const column of columns){
    const cell=node('td',column.value(card)||'—',column.cls);row.append(cell);
    if(!readOnly()&&(column.cls==='trello-progress'||column.cls==='trello-grade')){
     cell.classList.add('trello-editable');cell.tabIndex=0;cell.title='双击修改';
     const edit=()=>editCell(cell,card,column.cls==='trello-progress'?'progress':'grade',column.value(card));
     cell.onclick=event=>event.stopPropagation();cell.ondblclick=event=>{event.stopPropagation();edit();};
     cell.onkeydown=event=>{if(event.target===cell&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();edit();}};
    }
   }
   row.onclick=event=>{if(!event.target.closest('button,select,.trello-editable'))showDetail(card);};body.append(row);
  }
  if(!daily.length){const row=node('tr'),cell=node('td','当天没有到期卡片','trello-empty');cell.colSpan=columns.length+1;row.append(cell);body.append(row);}
  table.append(body);content.append(table);if(!daily.length)message('当天没有到期卡片，可选择其他日期。');else message('');

 }
 function editCell(cell,card,field,display){
  if(editingCell||busy)return;
  const menu=node('div',null,'trello-cell-options');menu.setAttribute('role','listbox');menu.setAttribute('aria-label',field==='progress'?'修改进度':'修改打分结果');
  const current=field==='progress'?card.idList:display;
  const options=field==='progress'?lists.filter(list=>!list.closed).map(list=>[list.id,list.name]):[['','未评分'],...['100','优','良','中','差'].map(value=>[value,value])];
  if(current&&!options.some(([value])=>value===current))options.unshift([current,display]);
  const edit={saving:false},epoch=boardEpoch;editingCell=edit;stopAutoRefresh();cell.replaceChildren(node('span',display||'—'),menu);
  const outside=event=>{if(!edit.saving&&!menu.contains(event.target))finish();};
  const finish=()=>{if(editingCell!==edit)return;document.removeEventListener('pointerdown',outside,true);editingCell=null;scheduleAutoRefresh();if(cell.isConnected)cell.textContent=display||'—';};
  document.addEventListener('pointerdown',outside,true);
  const save=async(value)=>{
   if(edit.saving||editingCell!==edit)return;
   if(value===current){finish();cell.focus();return;}
   edit.saving=true;menu.setAttribute('aria-busy','true');menu.querySelectorAll('button').forEach(option=>option.disabled=true);message('正在保存…');
   try{
    const data=await request('update_cell',card.id,{field,value});
    finish();if(epoch===boardEpoch){Object.assign(card,data.card);render();message('已保存到 Trello');}
   }catch(error){finish();if(epoch===boardEpoch)message('保存失败：'+error.message,true);}
  };
  for(const [value,label] of options){
   const option=button(label,()=>save(value));option.setAttribute('role','option');option.setAttribute('aria-selected',String(value===current));menu.append(option);
   option.onmousedown=event=>{if(event.button===0)event.preventDefault();};
  }
  menu.onfocusout=event=>{if(!edit.saving&&!menu.contains(event.relatedTarget))finish();};
  menu.onkeydown=event=>{
   event.stopPropagation();
   if(edit.saving)return;
   if(event.key==='Escape'){event.preventDefault();finish();cell.focus();return;}
   const choices=[...menu.querySelectorAll('button')],index=choices.indexOf(document.activeElement);
   const next=event.key==='ArrowDown'?(index+1)%choices.length:event.key==='ArrowUp'?(index-1+choices.length)%choices.length:event.key==='Home'?0:event.key==='End'?choices.length-1:null;
   if(next!==null){event.preventDefault();choices[next]?.focus();}
  };
  (menu.querySelector('[aria-selected=true]')||menu.firstElementChild)?.focus();
 }
 async function loadBoards(){const epoch=++boardEpoch;busy=true;message('正在检测 Trello…');try{const data=await request('boards');if(epoch!==boardEpoch)return;boards=(data.boards||[]).filter(b=>!b.closed);const select=document.getElementById('trello-board');select.replaceChildren(new Option('选择看板…',''));boards.forEach(b=>select.add(new Option(b.name,b.id)));if(!boards.some(b=>b.id===board)){board='';window.cnoteTools.setTrelloBoard('');}select.value=board;message('');if(board){await loadBoard();return;}busy=false;guide(boards.length?'请选择右上方的 Trello 看板。':'当前账号没有可用看板，请先在 Trello 创建看板。');}catch(error){if(epoch!==boardEpoch)return;busy=false;failure(error,loadBoards);}}
 async function loadBoard(silent=false){
  stopAutoRefresh();const epoch=++boardEpoch;busy=true;lastRefreshAt=Date.now();
  if(!silent){detailEpoch++;removeDetail();render();}
  if(!board){busy=false;guide();return;}
  try{const data=await request('board',board);if(epoch!==boardEpoch)return;lists=data.lists||[];cards=data.cards||[];busy=false;render();}
  catch(error){if(epoch!==boardEpoch)return;busy=false;if(!silent)render();failure(error,loadBoard);}
  finally{if(epoch===boardEpoch)scheduleAutoRefresh();}
 }
 function updateHomeworkDownload(){
  const control=document.getElementById('trello-download-homework');if(!control)return;
  control.disabled=downloadingHomework||busy||!connected||!board;
  control.textContent=downloadingHomework?'正在下载…':'下载作业';
 }
 async function downloadHomework(){
  if(downloadingHomework||busy||!connected||!board)return;
  const date=dayKey(selected),homework=cards.filter(card=>!card.closed&&dueDay(card)===date).map(card=>({id:card.id,name:card.name}));
  if(!homework.length){message(`${date} 没有作业`);return;}
  downloadingHomework=true;updateHomeworkDownload();
  let saved=0;const failed=[];
  try{
   const files=[];
   for(const card of homework){
    message(`正在读取 ${date} 的提交附件：${card.name}`);
    try{const result=await request('homework_attachments',card.id,{name:card.name,date});for(const file of result.files||[])files.push({...file,card:card.id});}
    catch(error){failed.push(`${card.name}：${error.message}`);}
   }
   for(const [index,file] of files.entries()){
    message(`正在下载 ${index+1}/${files.length}：${file.name}`);
    try{await request('download_homework_attachment',file.card,{attachment:file.id,name:file.name});saved++;}
    catch(error){if(error.code==='download_permission_denied')throw error;failed.push(`${file.name}：${error.message}`);}
   }
   message((saved?`${date} 已下载 ${saved} 个附件到下载目录/CNote`:failed.length?`${date} 未下载成功`:`${date} 没有可下载的图片或音频`)+(failed.length?`；${failed.length} 项失败：${failed.slice(0,3).join('；')}`:''),!!failed.length);
  }catch(error){message(`下载已停止，已保存 ${saved} 个附件：${error.message}`,true);}
  finally{downloadingHomework=false;updateHomeworkDownload();}
 }
 function removeDetail(){
  closeImageViewer();originalImages.clear();originalData.clear();
  const detail=document.getElementById('trello-detail');
  detail?.querySelectorAll('audio,video').forEach(media=>media.pause());
  detail?.remove();for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls.clear();
 }
 async function shareImage(attachment,cardId,feedback){
  if(sharingImage)return;
  sharingImage=true;
  feedback('正在准备分享原图…');
  try{
   const result=await request('share_image',cardId,{attachment:attachment.id,name:attachment.name,image:originalData.get(attachment.id)});
   feedback(result.shared?'图片已分享':'已取消分享');
  }catch(error){feedback('分享失败：'+error.message);}
  finally{sharingImage=false;}
 }
 function imageMenu(image,attachment,cardId,feedback){
  let saving=false;
  image.addEventListener('contextmenu',event=>{
   event.preventDefault();event.stopPropagation();
   root.querySelector('.trello-image-menu')?.remove();
   const menu=node('div',null,'trello-image-menu'),hasPopover=typeof menu.showPopover==='function';
   if(hasPopover)menu.setAttribute('popover','manual');menu.setAttribute('role','menu');
   const listeners=new AbortController();
   const closeMenu=()=>{listeners.abort();if(hasPopover&&menu.matches(':popover-open'))menu.hidePopover();menu.remove();};
   document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu();},{capture:true,signal:listeners.signal});
   const save=button(saving?'正在下载原图…':'下载原图',async()=>{
    if(saving)return;closeMenu();saving=true;feedback('请选择图片保存位置…');
    try{const result=await request('download',cardId,{attachment:attachment.id,name:attachment.name,image:originalData.get(attachment.id)},feedback);feedback(result.saved?'原图已保存':'已取消保存');}
    catch(error){feedback('下载失败：'+error.message);}
    finally{saving=false;}
   });save.disabled=saving;save.setAttribute('role','menuitem');
   const copy=button('复制图片',async()=>{
    closeMenu();feedback('正在复制原图…');
    try{await request('copy_image',cardId,{attachment:attachment.id,image:originalData.get(attachment.id)});feedback('图片已复制');}
    catch(error){feedback('复制失败：'+error.message);}
   });copy.setAttribute('role','menuitem');
   const share=button('分享图片',()=>{closeMenu();shareImage(attachment,cardId,feedback);});
   share.disabled=sharingImage;share.setAttribute('role','menuitem');
   const open=button('在页面中打开',()=>{closeMenu();openLink(attachment.url);});open.setAttribute('role','menuitem');
   menu.append(copy,share,open,save);
   menu.addEventListener('click',event=>event.stopPropagation());
   (image.closest('dialog')||root).append(menu);if(hasPopover)menu.showPopover();
   menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+'px';
   menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+'px';
   menu.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeMenu();image.focus();}});
   if(hasPopover)menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open'))closeMenu();});save.focus();
  });
 }
 function imageRecognition(attachment,cardId,epoch){
  const panel=node('div',null,'trello-image-transcript');panel.hidden=true;panel.setAttribute('role','status');
  const control=button('',async()=>{
   if(control.disabled)return;
   control.disabled=true;control.setAttribute('aria-busy','true');panel.hidden=false;panel.textContent='正在识别图片文字…';
   try{
    const result=await request('recognize_image',cardId,{attachment:attachment.id});
    if(epoch!==detailEpoch||!panel.isConnected)return;
    if(typeof result?.text!=='string'||!result.text.trim())throw Error('未识别到文字，请重试');
    panel.replaceChildren(node('strong','识别文本'),node('pre',result.text));
   }catch(error){if(epoch===detailEpoch&&panel.isConnected)panel.textContent='识别失败：'+error.message;}
   finally{control.disabled=false;control.removeAttribute('aria-busy');}
  },'trello-image-ocr trello-image-icon');
  control.title='识别图片文字';control.setAttribute('aria-label','识别图片文字');
  const icon=node('i',null,'bi bi-upc-scan');icon.setAttribute('aria-hidden','true');control.append(icon);
  return {control,panel};
 }
 function closeImageViewer(){if(imageViewer){const current=imageViewer;imageViewer=null;current.observer.disconnect();current.dialog.close();current.dialog.remove();}}
 async function openImageViewer(attachment,cardId,epoch,thumbnail){
  closeImageViewer();if(epoch!==detailEpoch)return;
  const dialog=node('dialog',null,'trello-image-viewer');dialog.id='trello-image-viewer';
  const toolbar=node('div',null,'trello-image-toolbar'),title=node('strong',attachment.name||'附件图片'),status=node('span','正在加载原图…');status.setAttribute('role','status');
  const viewport=node('div',null,'trello-image-viewport'),stage=node('div',null,'trello-image-stage'),image=node('img');image.alt=attachment.name||'附件图片';image.draggable=false;stage.append(image);viewport.append(stage);
  let rotation=0,scale=1,fit=true;
  const layout=()=>{if(!image.naturalWidth)return;const swapped=rotation%180!==0,w=swapped?image.naturalHeight:image.naturalWidth,h=swapped?image.naturalWidth:image.naturalHeight;if(fit)scale=Math.min((viewport.clientWidth-24)/w,(viewport.clientHeight-24)/h,1);scale=Math.max(.01,scale);stage.style.width=Math.max(viewport.clientWidth,w*scale+24)+'px';stage.style.height=Math.max(viewport.clientHeight,h*scale+24)+'px';image.style.width=image.naturalWidth*scale+'px';image.style.height=image.naturalHeight*scale+'px';image.style.transform=`translate(-50%,-50%) rotate(${rotation}deg)`;zoom.textContent=Math.round(scale*100)+'%';viewport.scrollLeft=(stage.offsetWidth-viewport.clientWidth)/2;viewport.scrollTop=(stage.offsetHeight-viewport.clientHeight)/2;};
  const zoom=node('span','100%','trello-image-zoom');
  const changeScale=factor=>{fit=false;scale=Math.min(8,Math.max(.01,scale*factor));layout();};
  const actions={zoomOut:()=>changeScale(1/1.25),zoomIn:()=>changeScale(1.25),fit:()=>{fit=true;layout();},actual:()=>{fit=false;scale=1;layout();},left:()=>{rotation=(rotation+270)%360;layout();},right:()=>{rotation=(rotation+90)%360;layout();}};
  const iconButton=(label,icon,shortcut,action)=>{const control=button('',action,'trello-image-icon');control.setAttribute('aria-label',label);if(shortcut)control.setAttribute('aria-keyshortcuts',shortcut==='+'?'Plus':shortcut);control.title=shortcut?`${label}（${shortcut}）`:label;const glyph=node('i',null,'bi bi-'+icon);glyph.setAttribute('aria-hidden','true');control.append(glyph);return control;};
  toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','图片查看工具');
  const feedback=text=>{status.textContent=text;};
  const recognition=imageRecognition(attachment,cardId,epoch);
  toolbar.append(title,recognition.control,iconButton('缩小','zoom-out','-',actions.zoomOut),zoom,iconButton('放大','zoom-in','+',actions.zoomIn),iconButton('适应窗口','fullscreen-exit','0',actions.fit),iconButton('原始大小','arrows-fullscreen','1',actions.actual),iconButton('逆时针旋转','arrow-counterclockwise','Shift+R',actions.left),iconButton('顺时针旋转','arrow-clockwise','R',actions.right),iconButton('分享图片','share',null,()=>shareImage(attachment,cardId,feedback)),iconButton('关闭图片','x-lg','Escape',closeImageViewer));
  dialog.addEventListener('keydown',event=>{
   if(event.target.closest('.trello-image-menu'))return;
   if(event.isComposing||event.altKey)return;
   const key=event.key;let action;
   if(key==='+'||key==='='||event.code==='NumpadAdd')action=actions.zoomIn;
   else if(key==='-'||event.code==='NumpadSubtract')action=actions.zoomOut;
   else if(!event.metaKey&&!event.ctrlKey){
    if(key==='0')action=actions.fit;else if(key==='1')action=actions.actual;
    else if(event.code==='KeyR')action=event.shiftKey?actions.left:actions.right;
    else if(key==='Escape')action=closeImageViewer;
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))action=()=>{const distance=event.shiftKey?240:80;viewport.scrollBy(key==='ArrowLeft'?-distance:key==='ArrowRight'?distance:0,key==='ArrowUp'?-distance:key==='ArrowDown'?distance:0);};
   }
   if(action){event.preventDefault();event.stopImmediatePropagation();action();}
  },true);
  const content=node('div',null,'trello-image-content');content.append(viewport,recognition.panel);
  dialog.append(toolbar,status,content);root.append(dialog);const observer=new ResizeObserver(()=>{if(fit)layout();});const current={dialog,observer};imageViewer=current;dialog.addEventListener('cancel',event=>{event.preventDefault();closeImageViewer();});dialog.showModal();observer.observe(viewport);
  imageMenu(image,attachment,cardId,feedback);
  image.onload=layout;image.src=thumbnail;
  let drag=null;viewport.onpointerdown=event=>{if(event.button!==0)return;drag={x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging');event.preventDefault();};viewport.onpointermove=event=>{if(drag){viewport.scrollLeft=drag.left+drag.x-event.clientX;viewport.scrollTop=drag.top+drag.y-event.clientY;}};viewport.onpointerup=viewport.onpointercancel=()=>{drag=null;viewport.classList.remove('dragging');};
  const loadOriginal=async()=>{
   status.replaceChildren(node('span','正在加载原图…'));
   try{
    let original=originalImages.get(attachment.id);
    if(!original){original=request('attachment',cardId,{attachment:attachment.id,original:true}).then(result=>{if(epoch!==detailEpoch)return null;if(!result.mime?.startsWith('image/'))throw Error('附件不是可预览的图片');originalData.set(attachment.id,result);const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:result.mime}));mediaUrls.add(url);return url;});originalImages.set(attachment.id,original);}
    const url=await original;if(!url||imageViewer!==current||epoch!==detailEpoch)return;
    image.onload=()=>{if(imageViewer===current){layout();status.textContent=`原图 · ${image.naturalWidth} × ${image.naturalHeight} 像素`;}};image.onerror=()=>{if(imageViewer===current){originalImages.delete(attachment.id);originalData.delete(attachment.id);URL.revokeObjectURL(url);mediaUrls.delete(url);image.onerror=null;image.src=thumbnail;status.replaceChildren(node('span','原图无法解码'),button('重试原图',loadOriginal));}};image.src=url;
   }catch(error){originalImages.delete(attachment.id);originalData.delete(attachment.id);if(imageViewer===current&&epoch===detailEpoch)status.replaceChildren(node('span',error.message),button('重试原图',loadOriginal));}
  };loadOriginal();
 }
 function renderAttachments(body,attachments,cardId,epoch){
  const date=attachment=>{const value=Date.parse(attachment.date||'');return Number.isFinite(value)?value:0;};
  const queue=[],gallery=node('div',null,'trello-attachments-grid');body.append(gallery);
  for(const attachment of [...attachments].sort((a,b)=>date(b)-date(a))){
   const figure=node('figure',null,'trello-attachment-preview'),caption=node('figcaption');
   const info=node('div'),name=node('strong',attachment.name||'附件');name.title=attachment.name||'附件';info.append(name,node('small',date(attachment)?`上传于 ${new Date(date(attachment)).toLocaleString()}`:'上传时间未知'));
   const knownImage=attachment.mimeType?.startsWith('image/')||/\.(jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(attachment.name||'');
   const actions=node('div',null,'trello-attachment-actions');
   const transcript=node('div',null,'trello-audio-transcript');transcript.hidden=true;transcript.setAttribute('role','status');
   const addAudioDownload=()=>{
    if(actions.querySelector('.trello-audio-download')||attachment.isUpload===false)return;
    const transcribe=button('ASR',async()=>{
     if(transcribe.disabled)return;
     transcribe.disabled=true;transcribe.textContent='转写中…';transcript.hidden=false;transcript.textContent='正在识别音频…';
     try{
      const result=await request('transcribe_audio',cardId,{attachment:attachment.id});
      if(epoch!==detailEpoch||!transcript.isConnected)return;
      if(typeof result?.text!=='string'||!result.text.trim())throw Error('未识别到文本，请重试');
      transcript.replaceChildren(node('strong','ASR 转写文本'),node('pre',result.text));
     }catch(error){if(epoch===detailEpoch&&transcript.isConnected)transcript.textContent='转写失败：'+error.message;}
     finally{transcribe.disabled=false;transcribe.textContent='ASR';}
    },'trello-audio-asr');
    transcribe.title='ASR 转文本';transcribe.setAttribute('aria-label','ASR 转文本');
    const download=button('',async()=>{
     download.disabled=true;
     try{const result=await request('download_audio',cardId,{attachment:attachment.id,name:attachment.name});if(epoch===detailEpoch)message(result.saved?'音频已保存':'已取消保存');}
     catch(error){if(epoch===detailEpoch)message('下载失败：'+error.message,true);}
     finally{download.disabled=false;}
    },'trello-audio-download');
    download.title='Download audio';download.setAttribute('aria-label','Download audio');
    const icon=node('i',null,'bi bi-download');icon.setAttribute('aria-hidden','true');download.append(icon);actions.append(transcribe,download);
   };
   figure.classList.toggle('trello-image-tile',knownImage);caption.append(info);if(!knownImage){
    const open=button('',()=>openLink(attachment.url),'trello-open-attachment');open.title='打开原附件';open.setAttribute('aria-label','打开原附件');
    const icon=node('i',null,'bi bi-box-arrow-up-right');icon.setAttribute('aria-hidden','true');open.append(icon);actions.append(open);caption.append(actions);
   }
   if(attachment.mimeType?.startsWith('audio/')||/\.(mp3|m4a|wav|ogg|opus|aac)$/i.test(attachment.name||''))addAudioDownload();
   const preview=node('div',attachment.isUpload===false?(knownImage?'外部图片附件暂不支持本地读取。':'外部链接附件，可打开原附件查看。'):'正在加载附件…','trello-attachment-content');figure.append(caption,preview,transcript);gallery.append(figure);
   if(attachment.isUpload===false)continue;
   const load=async()=>{
    if(epoch!==detailEpoch||!preview.isConnected)return;
    preview.replaceChildren(node('p','正在加载附件…'));
    const failed=text=>{preview.replaceChildren(node('p',text),button('重试加载',()=>load()));};
    try{
     const result=await request('attachment',cardId,{attachment:attachment.id});
     if(epoch!==detailEpoch||!preview.isConnected)return;
     const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0)),mime=result.mime||'';
     if(mime.startsWith('text/')||mime==='application/json'){preview.replaceChildren(node('pre',new TextDecoder().decode(bytes)));return;}
     const url=URL.createObjectURL(new Blob([bytes],{type:mime}));mediaUrls.add(url);let media;
     if(mime.startsWith('image/')){media=node('img');media.alt=attachment.name||'附件图片';figure.classList.add('trello-image-tile');caption.replaceChildren(info);}
     else if(mime.startsWith('audio/')||mime.startsWith('video/')){if(mime.startsWith('audio/'))addAudioDownload();media=node(mime.startsWith('audio/')?'audio':'video');media.controls=true;media.preload='metadata';media.setAttribute('aria-label',attachment.name||'附件');if(media.tagName==='VIDEO')media.playsInline=true;}
     else if(mime==='application/pdf'){media=node('iframe');media.title=attachment.name||'PDF 附件';media.setAttribute('sandbox','');}
     else {URL.revokeObjectURL(url);mediaUrls.delete(url);failed('此附件暂不支持内嵌预览，请打开原附件。');return;}
     media.onerror=()=>{if(epoch===detailEpoch&&preview.isConnected){URL.revokeObjectURL(url);mediaUrls.delete(url);failed(mime.startsWith('image/')?'图片加载失败，请重试。':'此附件无法在当前浏览器预览，可重试或打开原附件。');}};
     media.src=url;if(mime.startsWith('image/')){imageMenu(media,attachment,cardId,text=>message(text,text.includes('失败：')));const thumb=button('',()=>openImageViewer(attachment,cardId,epoch,url),'trello-image-thumb');thumb.setAttribute('aria-label','放大图片：'+(attachment.name||'附件图片'));thumb.append(media);preview.replaceChildren(thumb);}else preview.replaceChildren(media);
    }catch(error){if(epoch===detailEpoch&&preview.isConnected)failed(error.message);}
   };
   queue.push(load);
  }
  // Limit concurrent downloads while keeping each attachment independently retryable.
  const drain=async()=>{while(queue.length&&epoch===detailEpoch)await queue.shift()();};drain();drain();
 }
 const homeworkResults=new Map();
 function homeworkFields(card){
  const desc=String(card.desc||'');let meta={};try{const parsed=JSON.parse(desc);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))meta=parsed;}catch{}
  const line=names=>desc.match(new RegExp('^[ \\t]*(?:'+names+')[ \\t]*[:：][ \\t]*([^\\r\\n]*)','mi'))?.[1].trim()||'';
  const type=meta.type||line('作业类型|类型|type'),title=card.name||'';
  const kind=/口算/.test(title)||/^(口算|arithmetic)$/i.test(type)?'arithmetic':/^(阅读英语|english_reading|reading)$/.test(type)||(/英语|英文/.test(title)&&/阅读|朗读/.test(title))||!!meta.reading_text||/^[ \t]*(?:英语|英文)原文[ \t]*[:：]/m.test(desc)?'reading':/^(背单词|word_memorization|dictation)$/.test(type)||/单词听写|英语.*听写|听写.*英语|背单词/.test(title)?'dictation':'';
  const block=names=>{const marker=desc.match(new RegExp('^[ \\t]*(?:'+names+')[ \\t]*[:：][ \\t]*','m'));return marker?desc.slice(marker.index+marker[0].length).split(/\n[ \t]*(?:英语译文|作业要求|打分结果|阅读英语链接|作业类型|预计用时)[ \t]*[:：]/)[0].trim():'';};
  const task=String(meta.task||block('作业内容|task'));
  const count=Number(meta.count||line('本次应完成题数|题数')||title.match(/(\d+)\s*题/)?.[1]||desc.match(/(?:完成|前|共)\s*(\d+)\s*题/)?.[1]||task.split('\n').filter(s=>/[=＝]/.test(s)).length)||'';
  const link=String(meta.link||line('阅读英语链接|翻译链接|作业链接|链接')||task.match(/(?:https?:\/\/[^\s)]+|\/ai\/translate[^\s)]+)/)?.[0]||'').replace(/^\[[^\]]*\]\((.*)\)$/,'$1');
  let words=meta.words||line('背单词|单词听写|听写单词|词表')||(kind==='dictation'?task:'');
  if(Array.isArray(words))words=words.join('\n');
  if(kind==='dictation'){
   try{const url=new URL(link||words,'https://www.cyeam.com');if(url.pathname==='/ai/translate'&&url.searchParams.has('words'))words=url.searchParams.get('words');}catch{}
   words=String(words).replace(/\(([^()]*)\)/g,' $1').replace(/（[^（）]*）/g,'').split(/[,，;；\r\n]+/).map(s=>s.trim().replace(/ +/g,' ')).filter(Boolean).join('\n');
  }
  return {kind,count,words:String(words||''),reference:String(meta.reading_text||block('英语原文|英文原文')||''),link};
 }
 function homeworkReview(action){
  const text=action.data?.text?.trim();if(!text?.startsWith('作业批改：'))return null;
  try{
   const review=JSON.parse(text.slice('作业批改：'.length));
   if(review.version!==1||!['text','image','audio'].includes(review.type))return null;
   if(review.type==='text'?typeof review.text!=='string'||!review.text.trim()||Object.hasOwn(review,'attachment_id'):typeof review.attachment_id!=='string'||!review.attachment_id.trim()||Object.hasOwn(review,'text'))return null;
   if(Object.hasOwn(review,'has_errors')&&typeof review.has_errors!=='boolean')return null;
   return {...review,id:action.id,date:action.date};
  }catch{return null;}
 }
 function renderHomework(body,card,attachments,epoch,saved){
  const fields=homeworkFields(card);if(!fields.kind)return;
  const section=node('section',null,'trello-homework-review'),status=node('p'),actions=node('div',null,'trello-homework-actions');status.setAttribute('role','status');
  const reading=fields.kind==='reading';
  const candidates=attachments.filter(a=>a.isUpload!==false&&(reading?/^audio\//.test(a.mimeType||'')||/\.(m4a|mp3|wav|webm|ogg|aac|flac|amr|3gp|opus)$/i.test(a.name||''):/^image\/(jpeg|png|webp)$/.test(a.mimeType||'')||/\.(jpe?g|png|webp)$/i.test(a.name||''))).sort((a,b)=>String(b.date||b.id).localeCompare(String(a.date||a.id)));
  const attachment=candidates[0];
  // Tablet attachments carry one UUID per submission. Keep older submissions out.
  const submission=a=>String(a?.name||'').match(/_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.[^.]+$/i)?.[1];
  const group=!reading&&submission(attachment)?candidates.filter(a=>submission(a)===submission(attachment)).sort((a,b)=>String(a.date||a.id).localeCompare(String(b.date||b.id))):attachment?[attachment]:[];
  let publicationPending=false,reviewing=false,loading=false;
  const missing=()=>group.length>2?'同一次提交超过2张图片，请分批批改。':!attachment?(reading?'暂无朗读录音，请先提交作业。':'暂无作业图片，请先提交作业。'):reading&&!fields.reference?'卡片缺少英文原文，请补充作业描述。':fields.kind==='dictation'&&!fields.words?'卡片缺少听写词表，请补充作业描述。':fields.kind==='arithmetic'&&(!Number.isInteger(fields.count)||fields.count<1||fields.count>100)?'卡片缺少本次应完成题数（1～100），请补充作业描述。':'';
  const submit=button('开始自动阅卷',async()=>{
   if(submit.disabled)return;
   const extra={kind:fields.kind,attachment:attachment.id,...(!reading?{attachments:group.map(a=>a.id)}:{}),...(reading?{reference:fields.reference}:fields.kind==='dictation'?{words:fields.words}:{count:fields.count})},key=cacheKey();
   reviewing=true;sync();status.textContent='正在阅卷并保存结果…';actions.replaceChildren();
   try{const data=await request('review_homework',card.id,extra);homeworkResults.set(key,data);if(epoch===detailEpoch)display(data,true);}
   catch(error){if(epoch===detailEpoch)status.textContent='阅卷失败：'+error.message;}
   finally{reviewing=false;sync();}
  },'primary');
  section.append(node('h3','自动阅卷'),submit,status,actions);body.append(section);
  const sync=()=>{submit.disabled=publicationPending||reviewing||loading||!!missing();};
  const cacheKey=()=>JSON.stringify([card.id,fields.kind,group.map(a=>a.id),reading?fields.reference:fields.kind==='dictation'?fields.words:String(fields.count)]);
  const applyPublication=data=>{
   if(!data.card)return;
   Object.assign(card,data.card);const index=cards.findIndex(c=>c.id===card.id);if(index>=0)cards[index]={...cards[index],...data.card};
   if(!lists.some(l=>l.id===card.idList))lists.push({id:card.idList,name:data.report?.grade==='100'?'已完成':'待改错'});
   render();body.querySelector('.trello-description').textContent=card.desc||'暂无描述';
   body.querySelector('.trello-card-status').textContent=`${lists.find(l=>l.id===card.idList)?.name||'未知进度'} · ${card.dueComplete?'已标记完成':'未标记完成'}`;
  };
  const display=(data,apply=false)=>{
   actions.replaceChildren();publicationPending=data.published===false;sync();
   if(data.published===true){status.textContent='阅卷结果已保存到 Trello';if(apply)applyPublication(data);}
   else if(publicationPending){
    status.textContent='阅卷完成，保存失败：'+(data.publication_error||'请重试保存结果');
    const retry=button('重试保存结果',async()=>{
     retry.disabled=true;status.textContent='正在保存阅卷结果…';
     try{const updated=await request('publish_homework',card.id,{review_id:data.review_id});homeworkResults.set(cacheKey(),updated);if(epoch===detailEpoch)display(updated,true);}
     catch(error){if(epoch===detailEpoch){status.textContent='保存失败：'+error.message;retry.disabled=false;}}
    });actions.append(retry);
   }else status.textContent='阅卷结果尚未确认保存，请重新打开卡片核对。';
  };
  const cached=homeworkResults.get(cacheKey());
  if(saved||cached)display(saved||cached);else status.textContent=missing();
  sync();
  if(reading&&!fields.reference&&fields.link&&!publicationPending){
   loading=true;sync();if(!saved&&!cached&&!reviewing)status.textContent='正在准备课文…';
   request('reading_source',card.id,{link:fields.link}).then(data=>{
    if(epoch!==detailEpoch)return;fields.reference=data.reference||'';loading=false;sync();if(!saved&&!cached&&!reviewing)status.textContent=missing();
   }).catch(()=>{if(epoch===detailEpoch){loading=false;sync();if(!saved&&!cached&&!reviewing)status.textContent='课文读取失败，请稍后重新打开卡片。';}});
  }
 }
 async function showDetail(card){const epoch=++detailEpoch;removeDetail();const dialog=node('dialog',null,'trello-detail');dialog.id='trello-detail';const close=()=>{detailEpoch++;dialog.close();removeDetail();};const header=node('div',null,'trello-detail-header');header.append(node('h2',card.name),button('关闭',close));const body=node('div','正在读取完整信息…','trello-detail-body');dialog.append(header,body);root.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const outside=event=>{const bounds=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);};
  let backdropPressed=false;
  dialog.addEventListener('pointerdown',event=>{backdropPressed=event.button===0&&outside(event);});
  dialog.addEventListener('pointercancel',()=>{backdropPressed=false;});
  dialog.addEventListener('click',event=>{const dismiss=backdropPressed&&outside(event);backdropPressed=false;if(dismiss)close();});
  dialog.showModal();
  try{const data=await request('card',card.id);if(epoch!==detailEpoch)return;const full=data.card;body.replaceChildren();body.append(node('p',`${lists.find(l=>l.id===full.idList)?.name||'未知进度'} · ${full.dueComplete?'已标记完成':'未标记完成'}`,'trello-card-status'),node('p',full.due?`截止：${new Date(full.due).toLocaleString()}`:'无截止日期'),node('h3','描述'),linkedText('div',full.desc||'暂无描述','trello-description'));
   if(full.labels?.length)body.append(node('p','标签：'+full.labels.map(l=>l.name||l.color).join('、')));
   if(full.members?.length)body.append(node('p','成员：'+full.members.map(m=>m.fullName||m.username).join('、')));
   for(const checklist of full.checklists||[]){body.append(node('h3',checklist.name));for(const item of checklist.checkItems||[])body.append(linkedText('p',(item.state==='complete'?'☑ ':'☐ ')+item.name));}
   if(!readOnly())renderHomework(body,full,data.attachments||[],epoch,data.homework_review);
   body.append(node('h3','附件'));
   if(readOnly()&&data.attachments?.length){
    const names=node('ul');
    for(const attachment of data.attachments)names.append(node('li',attachment.name||'附件'));
    body.append(names,button('在 Trello 打开',()=>openLink(full.url||card.url),'primary'));
   }else if(!readOnly())renderAttachments(body,data.attachments||[],card.id,epoch);
   if(!data.attachments?.length)body.append(node('p',data.partial?'附件可能未能加载':'暂无附件'));
   const activity=node('details',null,'trello-activity');activity.append(node('summary',`评论与活动（${(data.actions||[]).filter(a=>!homeworkReview(a)).length}）`));const records=node('ul',null,'trello-activity-list');
   for(const action of data.actions||[]){
    if(homeworkReview(action))continue;
    const entry=node('li',null,'trello-action');let text=action.data?.text;
    if(!text){const data=action.data||{};text=data.listBefore&&data.listAfter?`${data.listBefore.name} → ${data.listAfter.name}`:data.attachment?`${action.type==='deleteAttachment'?'删除':'上传'}附件：${data.attachment.name||''}`:data.old&&Object.hasOwn(data.old,'dueComplete')?(data.card?.dueComplete?'标记完成':'取消完成'):data.old&&Object.hasOwn(data.old,'desc')?'更新描述':data.old&&Object.hasOwn(data.old,'name')?'修改标题':({createCard:'创建卡片',copyCard:'复制卡片',updateCard:'更新卡片'})[action.type]||action.type;}
    if(String(text||'').trim().startsWith('作业批改：'))text='批改记录暂无法读取';
    const time=node('time',new Date(action.date).toLocaleString()),author=node('span',action.memberCreator?.fullName||'','trello-action-author'),content=linkedText('span',String(text||'').trim(),'trello-action-text');time.dateTime=action.date;content.title=String(text||'');author.title=author.textContent;entry.append(time,author,content);records.append(entry);
   }
   activity.append(records);if(!data.actions?.length)activity.append(node('p',data.partial?'活动可能未能加载':'暂无活动'));if(data.actions?.length>=1000)activity.append(node('p','仅显示最近 1000 条活动。'));body.append(activity);
   if(data.partial)body.append(node('p','部分信息加载失败，请关闭后重试，或打开 Trello 查看。'));if(!readOnly()||!data.attachments?.length)body.append(button(readOnly()?'在 Trello 打开':'在 Trello 查看完整卡片',()=>openLink(full.url||card.url),'primary'));
  }catch(error){if(epoch===detailEpoch){body.replaceChildren(node('p',error.message),button('重试',()=>showDetail(card)),button('在 Trello 打开',()=>openLink(card.url)));}}
 }
 window.cnoteTrello={receive,refresh,account,hide(){active=false;stopAutoRefresh();detailEpoch++;removeDetail();},show(){active=true;if(loaded){resumeAutoRefresh();return;}loaded=true;board=window.cnoteTools.state.trelloBoard||'';shell();render();restore();}};
})();
