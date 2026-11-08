'use strict';
(() => {
 const root=document.getElementById('trello-tool');
 let selected=new Date(),boards=[],lists=[],cards=[],board='',loaded=false,busy=false,serial=0,boardEpoch=0,detailEpoch=0,connected=false,apiKey='';
 const pending=new Map(),mediaUrls=new Set(),originalImages=new Map(),originalData=new Map();
 let imageViewer=null,autoTimer=null,active=false,lastRefreshAt=0;
 const AUTO_REFRESH_MS=60000;
 const dayKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 const dueDay=card=>card.due&&Number.isFinite(new Date(card.due).getTime())?dayKey(new Date(card.due)):'';
 function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;}
 function button(text,action,cls){const el=node('button',text,cls);el.type='button';el.onclick=action;return el;}
 function request(op,id,extra={},progress){return new Promise((resolve,reject)=>{const request=++serial;pending.set(request,{resolve,reject,progress});window.ipc.postMessage(JSON.stringify({type:'trello',request,op,id,...extra}));});}
 function receive(event){const item=pending.get(event.request);if(!item)return;if(event.progress){item.progress?.(event.progress);return;}pending.delete(event.request);event.error?item.reject(Object.assign(Error(event.error),{code:event.code})):item.resolve(event.data);}
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
  if(!panel.querySelector('.trello-table'))panel.replaceChildren(node('p','连接暂时不可用，已保存的关联信息会保留。','trello-empty'),button('重试连接',()=>retry()));
 }
 function restore(){request('status').then(data=>{connected=data.connected;apiKey=data.key||'';if(connected)loadBoards();else guide();}).catch(error=>failure(error,restore));}
 function webURL(url){
  try{
   const parsed=new URL(url);
   if(parsed.protocol==='https:'||parsed.protocol==='http:')return parsed.href;
  }catch{}
 }
 function openLink(url){const href=webURL(url);if(href)window.ipc.postMessage(JSON.stringify({type:'link',url:href}));}
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
 function shell(){root.innerHTML='<div class="trello-header"><div><div class="trello-eyebrow">TRELLO / WEEKLY PLANNER</div><h1>每一天，都有进展</h1></div><div class="trello-controls"><select id="trello-board" aria-label="选择 Trello 看板"></select><button id="trello-refresh" type="button" title="刷新 Trello（⌘R）" aria-keyshortcuts="Meta+R">刷新</button><button id="trello-settings" type="button">关联设置</button></div></div><div class="trello-nav"><div><button id="trello-prev" aria-label="上一周">‹</button><button id="trello-today">今天</button><button id="trello-next" aria-label="下一周">›</button></div><strong id="trello-range"></strong><span title="查看卡片详情时暂缓刷新">按截止日期 · 每分钟自动刷新</span></div><div id="trello-week" aria-label="周历"></div><div id="trello-message" role="status"></div><div id="trello-content"></div>';
  document.getElementById('trello-settings').onclick=()=>{boardEpoch++;busy=false;guide('',true);};
  document.getElementById('trello-prev').onclick=()=>shift(-7);document.getElementById('trello-next').onclick=()=>shift(7);document.getElementById('trello-today').onclick=()=>{selected=new Date();render();};document.getElementById('trello-refresh').onclick=refresh;document.getElementById('trello-board').onchange=e=>{lists=[];cards=[];board=e.target.value;window.cnoteTools.setTrelloBoard(board);loadBoard();};
 }
 function refresh(){if(!loaded||busy)return;if(connected){if(board)loadBoard();else loadBoards();}else restore();}
 function stopAutoRefresh(){clearTimeout(autoTimer);autoTimer=null;}
 function scheduleAutoRefresh(delay=AUTO_REFRESH_MS){
  stopAutoRefresh();if(!active||document.hidden||!connected||!board)return;
  autoTimer=setTimeout(()=>{autoTimer=null;if(!busy&&!root.querySelector('dialog[open]')&&document.getElementById('trello-content')?.querySelector('.trello-table'))loadBoard(true);else scheduleAutoRefresh();},delay);
 }
 function resumeAutoRefresh(){scheduleAutoRefresh(Math.max(0,AUTO_REFRESH_MS-(Date.now()-lastRefreshAt)));}
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAutoRefresh();else if(active&&loaded)resumeAutoRefresh();});
 function shift(days){selected.setDate(selected.getDate()+days);render();}
 function render(){
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
   daily.some(card=>grade(card))&&{label:'打分结果',value:grade,cls:'trello-grade',width:7},
   {label:'实际完成时间',value:card=>timeText(card.dateCompleted),cls:'trello-completed-at',width:17},
   {label:'预计完成时间',value:card=>timeText(card.due),cls:'trello-due-at',width:17},
   {label:'更新时间',value:card=>timeText(card.dateLastActivity),cls:'trello-updated-at',width:17}
  ].filter(Boolean);
  const head=node('thead'),heading=node('tr');for(const column of [{label:'标题',width:100-columns.reduce((sum,column)=>sum+column.width,0)},...columns]){const cell=node('th',column.label);cell.scope='col';cell.style.width=column.width+'%';heading.append(cell);}head.append(heading);table.append(head);
  const body=node('tbody');for(const card of daily.sort((a,b)=>rank(a)-rank(b)||listName(a).localeCompare(listName(b),'zh-CN')||completedAt(a)-completedAt(b)||timestamp(a.due)-timestamp(b.due))){
   const row=node('tr',null,'trello-task');row.dataset.completed=String(rank(card)>=3);
   const titleCell=node('td');titleCell.append(button(card.name,()=>showDetail(card),'trello-open-card'));
   row.append(titleCell);for(const column of columns)row.append(node('td',column.value(card)||'—',column.cls));
   row.onclick=event=>{if(!event.target.closest('button'))showDetail(card);};body.append(row);
  }
  if(!daily.length){const row=node('tr'),cell=node('td','当天没有到期卡片','trello-empty');cell.colSpan=columns.length+1;row.append(cell);body.append(row);}
  table.append(body);content.append(table);if(!daily.length)message('当天没有到期卡片，可选择其他日期。');else message('');

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
 function removeDetail(){
  closeImageViewer();originalImages.clear();originalData.clear();
  const detail=document.getElementById('trello-detail');
  detail?.querySelectorAll('audio,video').forEach(media=>media.pause());
  detail?.remove();for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls.clear();
 }
 function imageDownloadMenu(image,attachment,cardId,feedback){
  let saving=false;
  image.addEventListener('contextmenu',event=>{
   event.preventDefault();event.stopPropagation();
   root.querySelector('.trello-image-menu')?.remove();
   const menu=node('div',null,'trello-image-menu');menu.setAttribute('popover','manual');menu.setAttribute('role','menu');
   const listeners=new AbortController();
   const closeMenu=()=>{listeners.abort();if(menu.matches(':popover-open'))menu.hidePopover();menu.remove();};
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
   const open=button('在页面中打开',()=>{closeMenu();openLink(attachment.url);});open.setAttribute('role','menuitem');
   menu.append(copy,open,save);
   menu.addEventListener('click',event=>event.stopPropagation());
   (image.closest('dialog')||root).append(menu);menu.showPopover();
   menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+'px';
   menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+'px';
   menu.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeMenu();image.focus();}});
   menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open'))closeMenu();});save.focus();
  });
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
  const iconButton=(label,icon,shortcut,action)=>{const control=button('',action,'trello-image-icon');control.setAttribute('aria-label',label);control.setAttribute('aria-keyshortcuts',shortcut==='+'?'Plus':shortcut);control.title=`${label}（${shortcut}）`;const glyph=node('i',null,'bi bi-'+icon);glyph.setAttribute('aria-hidden','true');control.append(glyph);return control;};
  toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','图片查看工具');
  toolbar.append(title,iconButton('缩小','zoom-out','-',actions.zoomOut),zoom,iconButton('放大','zoom-in','+',actions.zoomIn),iconButton('适应窗口','fullscreen-exit','0',actions.fit),iconButton('原始大小','arrows-fullscreen','1',actions.actual),iconButton('逆时针旋转','arrow-counterclockwise','Shift+R',actions.left),iconButton('顺时针旋转','arrow-clockwise','R',actions.right),iconButton('关闭图片','x-lg','Escape',closeImageViewer));
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
  dialog.append(toolbar,status,viewport);root.append(dialog);const observer=new ResizeObserver(()=>{if(fit)layout();});const current={dialog,observer};imageViewer=current;dialog.addEventListener('cancel',event=>{event.preventDefault();closeImageViewer();});dialog.showModal();observer.observe(viewport);
  imageDownloadMenu(image,attachment,cardId,text=>{status.textContent=text;});
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
   figure.classList.toggle('trello-image-tile',knownImage);caption.append(info);if(!knownImage)caption.append(button('打开原附件',()=>openLink(attachment.url)));
   const preview=node('div',attachment.isUpload===false?(knownImage?'外部图片附件暂不支持本地读取。':'外部链接附件，可打开原附件查看。'):'正在加载附件…','trello-attachment-content');figure.append(caption,preview);gallery.append(figure);
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
     else if(mime.startsWith('audio/')||mime.startsWith('video/')){media=node(mime.startsWith('audio/')?'audio':'video');media.controls=true;media.preload='metadata';media.setAttribute('aria-label',attachment.name||'附件');if(media.tagName==='VIDEO')media.playsInline=true;}
     else if(mime==='application/pdf'){media=node('iframe');media.title=attachment.name||'PDF 附件';media.setAttribute('sandbox','');}
     else {URL.revokeObjectURL(url);mediaUrls.delete(url);failed('此附件暂不支持内嵌预览，请打开原附件。');return;}
     media.onerror=()=>{if(epoch===detailEpoch&&preview.isConnected){URL.revokeObjectURL(url);mediaUrls.delete(url);failed(mime.startsWith('image/')?'图片加载失败，请重试。':'此附件无法在当前浏览器预览，可重试或打开原附件。');}};
     media.src=url;if(mime.startsWith('image/')){imageDownloadMenu(media,attachment,cardId,text=>message(text,text.startsWith('下载失败')));const thumb=button('',()=>openImageViewer(attachment,cardId,epoch,url),'trello-image-thumb');thumb.setAttribute('aria-label','放大图片：'+(attachment.name||'附件图片'));thumb.append(media);preview.replaceChildren(thumb);}else preview.replaceChildren(media);
    }catch(error){if(epoch===detailEpoch&&preview.isConnected)failed(error.message);}
   };
   queue.push(load);
  }
  // Limit concurrent downloads while keeping each attachment independently retryable.
  const drain=async()=>{while(queue.length&&epoch===detailEpoch)await queue.shift()();};drain();drain();
 }
 async function showDetail(card){const epoch=++detailEpoch;removeDetail();const dialog=node('dialog',null,'trello-detail');dialog.id='trello-detail';const close=()=>{detailEpoch++;dialog.close();removeDetail();};const header=node('div',null,'trello-detail-header');header.append(node('h2',card.name),button('关闭',close));const body=node('div','正在读取完整信息…','trello-detail-body');dialog.append(header,body);root.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const outside=event=>{const bounds=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);};
  let backdropPressed=false;
  dialog.addEventListener('pointerdown',event=>{backdropPressed=event.button===0&&outside(event);});
  dialog.addEventListener('pointercancel',()=>{backdropPressed=false;});
  dialog.addEventListener('click',event=>{const dismiss=backdropPressed&&outside(event);backdropPressed=false;if(dismiss)close();});
  dialog.showModal();
  try{const data=await request('card',card.id);if(epoch!==detailEpoch)return;const full=data.card;body.replaceChildren();body.append(node('p',`${lists.find(l=>l.id===full.idList)?.name||'未知进度'} · ${full.dueComplete?'已标记完成':'未标记完成'}`),node('p',full.due?`截止：${new Date(full.due).toLocaleString()}`:'无截止日期'),node('h3','描述'),linkedText('div',full.desc||'暂无描述','trello-description'));
   if(full.labels?.length)body.append(node('p','标签：'+full.labels.map(l=>l.name||l.color).join('、')));
   if(full.members?.length)body.append(node('p','成员：'+full.members.map(m=>m.fullName||m.username).join('、')));
   for(const checklist of full.checklists||[]){body.append(node('h3',checklist.name));for(const item of checklist.checkItems||[])body.append(linkedText('p',(item.state==='complete'?'☑ ':'☐ ')+item.name));}
   body.append(node('h3','附件'));renderAttachments(body,data.attachments||[],card.id,epoch);if(!data.attachments?.length)body.append(node('p',data.partial?'附件可能未能加载':'暂无附件'));
   const activity=node('details',null,'trello-activity');activity.append(node('summary',`评论与活动（${(data.actions||[]).length}）`));const records=node('ul',null,'trello-activity-list');
   for(const action of data.actions||[]){
    const entry=node('li',null,'trello-action');let text=action.data?.text;
    if(!text){const data=action.data||{};text=data.listBefore&&data.listAfter?`${data.listBefore.name} → ${data.listAfter.name}`:data.attachment?`${action.type==='deleteAttachment'?'删除':'上传'}附件：${data.attachment.name||''}`:data.old&&Object.hasOwn(data.old,'dueComplete')?(data.card?.dueComplete?'标记完成':'取消完成'):data.old&&Object.hasOwn(data.old,'desc')?'更新描述':data.old&&Object.hasOwn(data.old,'name')?'修改标题':({createCard:'创建卡片',copyCard:'复制卡片',updateCard:'更新卡片'})[action.type]||action.type;}
    const time=node('time',new Date(action.date).toLocaleString()),author=node('span',action.memberCreator?.fullName||'','trello-action-author'),content=linkedText('span',String(text||'').trim(),'trello-action-text');time.dateTime=action.date;content.title=String(text||'');author.title=author.textContent;entry.append(time,author,content);records.append(entry);
   }
   activity.append(records);if(!data.actions?.length)activity.append(node('p',data.partial?'活动可能未能加载':'暂无活动'));if(data.actions?.length>=1000)activity.append(node('p','仅显示最近 1000 条活动。'));body.append(activity);
   if(data.partial)body.append(node('p','部分信息加载失败，请关闭后重试，或打开 Trello 查看。'));body.append(button('在 Trello 查看完整卡片',()=>openLink(full.url),'primary'));
  }catch(error){if(epoch===detailEpoch){body.replaceChildren(node('p',error.message),button('重试',()=>showDetail(card)),button('在 Trello 打开',()=>openLink(card.url)));}}
 }
 window.cnoteTrello={receive,refresh,hide(){active=false;stopAutoRefresh();detailEpoch++;removeDetail();},show(){active=true;if(loaded){resumeAutoRefresh();return;}loaded=true;board=window.cnoteTools.state.trelloBoard||'';shell();render();restore();}};
})();
