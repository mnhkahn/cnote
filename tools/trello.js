'use strict';
(() => {
 const root=document.getElementById('trello-tool');
 let selected=new Date(),boards=[],lists=[],cards=[],board='',loaded=false,busy=false,serial=0,boardEpoch=0,detailEpoch=0,connected=false,apiKey='';
 const pending=new Map(),mediaUrls=new Set();
 const dayKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 const dueDay=card=>card.due&&Number.isFinite(new Date(card.due).getTime())?dayKey(new Date(card.due)):'';
 function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;}
 function button(text,action,cls){const el=node('button',text,cls);el.type='button';el.onclick=action;return el;}
 function request(op,id,extra={}){return new Promise((resolve,reject)=>{const request=++serial;pending.set(request,{resolve,reject});window.ipc.postMessage(JSON.stringify({type:'trello',request,op,id,...extra}));});}
 function receive(event){const item=pending.get(event.request);if(!item)return;pending.delete(event.request);event.error?item.reject(Object.assign(Error(event.error),{code:event.code})):item.resolve(event.data);}
 function message(text,error=false){const el=document.getElementById('trello-message');if(el){el.textContent=text;el.dataset.error=String(error);}}
 function guide(error,settings=false,reauthorize=false){
  const panel=document.getElementById('trello-content');panel.replaceChildren();const box=node('div',null,'trello-guide');
  box.append(node('h2',connected?'Trello 关联设置':'关联你的 Trello 看板'),node('p',error||'连接 Trello 后，在这里按截止日期查看每天的卡片进度。'));
  if(connected&&!reauthorize){
   if(settings){box.append(node('p','已关联 · 自动保持连接'),node('p','凭据已保存到系统钥匙串。重启 CNote 会自动恢复，无需重复输入。'),button('返回看板',()=>loadBoards()),button('更换账号或重新授权',()=>guide('',true,true)));}
   else box.append(button('重新加载看板',()=>loadBoards()),button('关联设置',()=>guide('',true)));
   addDisconnect(box);panel.append(box);return;
  }
  const form=node('form');form.id='trello-connect-form';
  const key=node('input');key.id='trello-api-key';key.value=apiKey;key.autocomplete='off';key.spellcheck=false;key.placeholder='Trello API Key';key.required=true;
  const token=node('input');token.id='trello-token';token.type='password';token.autocomplete='off';token.placeholder='粘贴授权页面显示的 Token';token.required=true;
  const keyLabel=node('label','API Key');keyLabel.htmlFor=key.id;const tokenLabel=node('label','Token');tokenLabel.htmlFor=token.id;
  const feedback=node('p');feedback.id='trello-auth-feedback';feedback.setAttribute('role','status');
  const auth=button('打开 Trello 授权页面',async()=>{auth.disabled=true;feedback.textContent='正在打开授权页面…';try{const result=await request('authorize',undefined,{key:key.value.trim()});openLink(result.url);feedback.textContent='在浏览器中允许只读访问，再将页面显示的 Token 粘贴到下方。';}catch(error){feedback.textContent=error.message;}finally{auth.disabled=false;}});
  const submit=button('关联并保存');submit.type='submit';submit.className='primary';
  form.append(node('p','1. 填写 Trello API Key，再打开浏览器授权。'),keyLabel,key,auth,button('获取 API Key',()=>openLink('https://trello.com/apps/admin')),node('p','2. 授权后，将浏览器显示的 Token 粘贴到这里。'),tokenLabel,token,node('p','只需关联一次：使用长期只读授权，凭据保存在系统钥匙串，重启后自动连接。'),submit,feedback);
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;auth.disabled=true;feedback.textContent='正在验证并关联…';try{await request('connect',undefined,{key:key.value.trim(),token:token.value.trim()});apiKey=key.value.trim();token.value='';connected=true;board='';lists=[];cards=[];detailEpoch++;removeDetail();document.getElementById('trello-board').replaceChildren(new Option('选择看板…',''));window.cnoteTools.setTrelloBoard('');render();await loadBoards();}catch(error){feedback.textContent=error.message;}finally{submit.disabled=false;auth.disabled=false;}};
  box.append(form);
  if(connected)addDisconnect(box);
  panel.append(box);
 }
 function addDisconnect(box){
  const disconnect=button('断开关联',async()=>{disconnect.disabled=true;try{await request('disconnect');boardEpoch++;detailEpoch++;removeDetail();connected=false;board='';boards=[];lists=[];cards=[];window.cnoteTools.setTrelloBoard('');document.getElementById('trello-board').replaceChildren(new Option('选择看板…',''));render();guide();}catch(error){message(error.message,true);}finally{disconnect.disabled=false;}});box.append(disconnect);
 }
 function failure(error,retry){
  if(error.code==='auth_required'){guide(error.message,true,true);message('需要重新授权 Trello',true);return;}
  message(error.message,true);
  const panel=document.getElementById('trello-content');
  if(!panel.querySelector('.trello-table'))panel.replaceChildren(node('p','连接暂时不可用，已保存的关联信息会保留。','trello-empty'),button('重试连接',retry));
 }
 function restore(){request('status').then(data=>{connected=data.connected;apiKey=data.key||'';if(connected)loadBoards();else guide();}).catch(error=>failure(error,restore));}
 function openLink(url){try{const parsed=new URL(url);if(parsed.protocol==='https:'||parsed.protocol==='http:')window.ipc.postMessage(JSON.stringify({type:'link',url:parsed.href}));}catch{}}
 function shell(){root.innerHTML='<div class="trello-header"><div><div class="trello-eyebrow">TRELLO / WEEKLY PLANNER</div><h1>每一天，都有进展</h1></div><div class="trello-controls"><select id="trello-board" aria-label="选择 Trello 看板"></select><button id="trello-refresh" type="button">刷新</button><button id="trello-settings" type="button">关联设置</button></div></div><div class="trello-nav"><div><button id="trello-prev" aria-label="上一周">‹</button><button id="trello-today">今天</button><button id="trello-next" aria-label="下一周">›</button></div><strong id="trello-range"></strong><span>按截止日期</span></div><div id="trello-week" aria-label="周历"></div><div id="trello-message" role="status"></div><div id="trello-content"></div>';
  document.getElementById('trello-settings').onclick=()=>{boardEpoch++;busy=false;guide('',true);};
  document.getElementById('trello-prev').onclick=()=>shift(-7);document.getElementById('trello-next').onclick=()=>shift(7);document.getElementById('trello-today').onclick=()=>{selected=new Date();render();};document.getElementById('trello-refresh').onclick=()=>connected?(board?loadBoard():loadBoards()):restore();document.getElementById('trello-board').onchange=e=>{lists=[];cards=[];board=e.target.value;window.cnoteTools.setTrelloBoard(board);loadBoard();};
 }
 function shift(days){selected.setDate(selected.getDate()+days);render();}
 function render(){
  const first=new Date(selected);first.setDate(first.getDate()-(first.getDay()+6)%7);const last=new Date(first);last.setDate(last.getDate()+6);
  document.getElementById('trello-range').textContent=`${first.getFullYear()}年 ${first.getMonth()+1}月${first.getDate()}日 — ${last.getMonth()+1}月${last.getDate()}日`;
  const week=document.getElementById('trello-week');week.replaceChildren();
  for(let i=0;i<7;i++){const date=new Date(first);date.setDate(date.getDate()+i);const key=dayKey(date),count=cards.filter(c=>!c.closed&&dueDay(c)===key).length;const el=button('',()=>{selected=date;render();},'trello-day');el.setAttribute('aria-label',key);el.setAttribute('aria-pressed',String(key===dayKey(selected)));el.classList.toggle('is-today',key===dayKey(new Date()));el.append(node('span',['周一','周二','周三','周四','周五','周六','周日'][i]),node('strong',String(date.getDate())),node('small',count?`${count} 张卡片`:'—'));week.append(el);}
  if(!board)return;
  const content=document.getElementById('trello-content');content.replaceChildren();if(busy){content.append(node('p','正在加载看板…','trello-empty'));return;}
  const daily=cards.filter(c=>!c.closed&&dueDay(c)===dayKey(selected));const title=node('div',null,'trello-day-title');title.append(node('strong',`${selected.getMonth()+1}月${selected.getDate()}日`),node('span',`${daily.length} 张卡片`));content.append(title);
  const listName=card=>lists.find(list=>list.id===card.idList)?.name||'未知进度';
  const rank=card=>{const name=listName(card).trim();if(name==='待完成')return 0;if(name==='待改错')return 1;if(name==='已完成')return 3;if(name==='已改错')return 4;return card.dueComplete?3:2;};
  const grade=card=>String(card.desc||'').match(/^\s*打分结果\s*[:：]\s*([^\r\n]+)/m)?.[1].trim()||'—';
  const completedAt=card=>{const value=card.dateCompleted?Date.parse(card.dateCompleted):NaN;return Number.isFinite(value)?value:Number.MAX_SAFE_INTEGER;};
  const completionText=card=>{const value=completedAt(card);if(value===Number.MAX_SAFE_INTEGER)return '—';const date=new Date(value);return `${dayKey(date)} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;};
  const table=node('table',null,'trello-table');table.setAttribute('aria-label','当天 Trello 任务');
  const head=node('thead'),heading=node('tr');for(const label of ['标题','进度','打分结果','完成时间']){const cell=node('th',label);cell.scope='col';heading.append(cell);}head.append(heading);table.append(head);
  const body=node('tbody');for(const card of daily.sort((a,b)=>rank(a)-rank(b)||listName(a).localeCompare(listName(b),'zh-CN')||completedAt(a)-completedAt(b))){
   const row=node('tr',null,'trello-task');row.dataset.completed=String(rank(card)>=3);
   const titleCell=node('td');titleCell.append(button(card.name,()=>showDetail(card),'trello-open-card'));
   row.append(titleCell,node('td',listName(card),'trello-progress'),node('td',grade(card),'trello-grade'),node('td',completionText(card),'trello-completed-at'));
   row.onclick=event=>{if(!event.target.closest('button'))showDetail(card);};body.append(row);
  }
  if(!daily.length){const row=node('tr'),cell=node('td','当天没有到期卡片','trello-empty');cell.colSpan=4;row.append(cell);body.append(row);}
  table.append(body);content.append(table);if(!daily.length)message('当天没有到期卡片，可选择其他日期。');else message('');

 }
 async function loadBoards(){const epoch=++boardEpoch;busy=true;message('正在检测 Trello…');try{const data=await request('boards');if(epoch!==boardEpoch)return;boards=(data.boards||[]).filter(b=>!b.closed);const select=document.getElementById('trello-board');select.replaceChildren(new Option('选择看板…',''));boards.forEach(b=>select.add(new Option(b.name,b.id)));if(!boards.some(b=>b.id===board)){board='';window.cnoteTools.setTrelloBoard('');}select.value=board;message('');if(board){await loadBoard();return;}busy=false;guide(boards.length?'请选择右上方的 Trello 看板。':'当前账号没有可用看板，请先在 Trello 创建看板。');}catch(error){if(epoch!==boardEpoch)return;busy=false;failure(error,loadBoards);}}
 async function loadBoard(){const epoch=++boardEpoch;detailEpoch++;removeDetail();busy=true;render();if(!board){busy=false;guide();return;}try{const data=await request('board',board);if(epoch!==boardEpoch)return;lists=data.lists||[];cards=data.cards||[];busy=false;render();}catch(error){if(epoch!==boardEpoch)return;busy=false;render();failure(error,loadBoard);}}
 function removeDetail(){
  const detail=document.getElementById('trello-detail');
  detail?.querySelectorAll('audio,video').forEach(media=>media.pause());
  detail?.remove();for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls.clear();
 }
 function renderAttachments(body,attachments,cardId,epoch){
  const date=attachment=>{const value=Date.parse(attachment.date||'');return Number.isFinite(value)?value:0;};
  const queue=[];
  for(const attachment of [...attachments].sort((a,b)=>date(b)-date(a))){
   const figure=node('figure',null,'trello-attachment-preview'),caption=node('figcaption');
   const info=node('div');info.append(node('strong',attachment.name||'附件'),node('small',date(attachment)?`上传于 ${new Date(date(attachment)).toLocaleString()}`:'上传时间未知'));
   caption.append(info,button('打开原附件',()=>openLink(attachment.url)));
   const preview=node('div',attachment.isUpload===false?'外部链接附件，可打开原附件查看。':'正在加载附件…','trello-attachment-content');figure.append(caption,preview);body.append(figure);
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
     if(mime.startsWith('image/')){media=node('img');media.alt=attachment.name||'附件图片';}
     else if(mime.startsWith('audio/')||mime.startsWith('video/')){media=node(mime.startsWith('audio/')?'audio':'video');media.controls=true;media.preload='metadata';media.setAttribute('aria-label',attachment.name||'附件');if(media.tagName==='VIDEO')media.playsInline=true;}
     else if(mime==='application/pdf'){media=node('iframe');media.title=attachment.name||'PDF 附件';media.setAttribute('sandbox','');}
     else {URL.revokeObjectURL(url);mediaUrls.delete(url);failed('此附件暂不支持内嵌预览，请打开原附件。');return;}
     media.onerror=()=>{if(epoch===detailEpoch&&preview.isConnected){URL.revokeObjectURL(url);mediaUrls.delete(url);failed('此附件无法在当前浏览器预览，可重试或打开原附件。');}};
     media.src=url;preview.replaceChildren(media);
    }catch(error){if(epoch===detailEpoch&&preview.isConnected)failed(error.message);}
   };
   queue.push(load);
  }
  // Limit concurrent downloads while keeping each attachment independently retryable.
  const drain=async()=>{while(queue.length&&epoch===detailEpoch)await queue.shift()();};drain();drain();
 }
 async function showDetail(card){const epoch=++detailEpoch;removeDetail();const dialog=node('dialog',null,'trello-detail');dialog.id='trello-detail';const close=()=>{detailEpoch++;dialog.close();removeDetail();};const header=node('div',null,'trello-detail-header');header.append(node('h2',card.name),button('关闭',close));const body=node('div','正在读取完整信息…','trello-detail-body');dialog.append(header,body);root.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.showModal();
  try{const data=await request('card',card.id);if(epoch!==detailEpoch)return;const full=data.card;body.replaceChildren();body.append(node('p',`${lists.find(l=>l.id===full.idList)?.name||'未知进度'} · ${full.dueComplete?'已标记完成':'未标记完成'}`),node('p',full.due?`截止：${new Date(full.due).toLocaleString()}`:'无截止日期'),node('h3','描述'),node('div',full.desc||'暂无描述','trello-description'));
   if(full.labels?.length)body.append(node('p','标签：'+full.labels.map(l=>l.name||l.color).join('、')));
   if(full.members?.length)body.append(node('p','成员：'+full.members.map(m=>m.fullName||m.username).join('、')));
   for(const checklist of full.checklists||[]){body.append(node('h3',checklist.name));for(const item of checklist.checkItems||[])body.append(node('p',(item.state==='complete'?'☑ ':'☐ ')+item.name));}
   body.append(node('h3','附件'));renderAttachments(body,data.attachments||[],card.id,epoch);if(!data.attachments?.length)body.append(node('p',data.partial?'附件可能未能加载':'暂无附件'));
   body.append(node('h3','评论与活动'));for(const action of data.actions||[]){const entry=node('div',null,'trello-action');let text=action.data?.text;if(!text)text=action.data?.listBefore&&action.data?.listAfter?`${action.data.listBefore.name} → ${action.data.listAfter.name}`:action.type;entry.append(node('small',`${action.memberCreator?.fullName||''} · ${new Date(action.date).toLocaleString()}`),node('p',text));body.append(entry);}if(!data.actions?.length)body.append(node('p',data.partial?'活动可能未能加载':'暂无活动'));if(data.actions?.length>=1000)body.append(node('p','仅显示最近 1000 条活动。'));if(data.partial)body.append(node('p','部分信息加载失败，请关闭后重试，或打开 Trello 查看。'));body.append(button('在 Trello 查看完整卡片',()=>openLink(full.url),'primary'));
  }catch(error){if(epoch===detailEpoch){body.replaceChildren(node('p',error.message),button('重试',()=>showDetail(card)),button('在 Trello 打开',()=>openLink(card.url)));}}
 }
 window.cnoteTrello={receive,hide(){detailEpoch++;removeDetail();},show(){if(loaded)return;loaded=true;board=window.cnoteTools.state.trelloBoard||'';shell();render();restore();}};
})();
