'use strict';
(() => {
 let editor=document.getElementById('editor');
 const title=document.getElementById('title'), editorTemplate=editor.cloneNode(false), main=document.querySelector('main');
 editorTemplate.classList.add('note-editor');editorTemplate.removeAttribute('id');
 const stack=document.createElement('div');stack.className='editor-stack';editor.replaceWith(stack);
 const dialog=document.getElementById('dialog'), body=document.getElementById('dialog-body'), actions=document.getElementById('dialog-actions');
 let id='',active=null,serial=0,intent=0,selection=null,contextCell=null;
 const notes=new Map(),pendingWrites=new Set();
 const warmups=new Map();let warmTimer=null,cacheGeneration=0,cacheAccount=null,lastInput=0,syncRequested=false;
 let countTimer=null,pruneTimer=null,scrollPosition=0;
 main.addEventListener('scroll',()=>{scrollPosition=main.scrollTop;if(active)active.scroll=scrollPosition;},{passive:true});
 let composing=false,pendingLoad=null,dialogKind='',dialogQueue=[],pendingAction=null;
 const post=data=>window.ipc.postMessage(JSON.stringify(data));
 const text=(tag,value)=>{const el=document.createElement(tag);el.textContent=value;return el;};
 const safeURL=u=>{try{return ['https:','http:','mailto:'].includes(new URL(u).protocol);}catch{return false;}};
 function sanitize(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const allowed=new Set('P DIV SPAN BR H1 H2 H3 H4 H5 H6 STRONG B EM I U S STRIKE CODE PRE BLOCKQUOTE UL OL LI TABLE THEAD TBODY TFOOT TR TD TH INPUT LABEL A IMG HR SUB SUP'.split(' '));
  const forbidden=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','LINK','META','BASE','SVG','MATH','TEMPLATE']);
  for(const el of [...doc.body.querySelectorAll('*')]){
   if(forbidden.has(el.tagName)){el.remove();continue;}
   if(!allowed.has(el.tagName)){el.replaceWith(...el.childNodes);continue;}
   for(const a of [...el.attributes]){
    const k=a.name.toLowerCase();
    if(!['href','src','alt','title','colspan','rowspan','type','checked','class','style'].includes(k))el.removeAttribute(a.name);
    else if(k==='href'&&!safeURL(a.value))el.removeAttribute(k);
    else if(k==='src'&&!/^https:\/\//i.test(a.value)&&!/^data:image\/(png|jpeg|webp|gif|bmp);base64,/i.test(a.value))el.removeAttribute(k);
    else if(k==='style'&&/url\s*\(|expression|position\s*:|behavior|@import/i.test(a.value))el.removeAttribute(k);
   }
   if(el.tagName==='INPUT'){if(el.getAttribute('type')!=='checkbox')el.remove();else el.removeAttribute('style');}
  }
  return doc.body.innerHTML;
 }
 // Keep the actual editing trees alive: switching a cached note never serializes or reparses HTML.
 function record(noteId,noteTitle='',html=null){
  const node=editorTemplate.cloneNode(false);
  const pane=document.createElement('div');pane.className='editor-pane';pane.setAttribute('aria-hidden','true');pane.append(node);
  const n={id:noteId,account:cacheAccount,title:noteTitle,node,pane,height:0,source:html,seq:0,saved:0,sent:0,timer:null,loaded:html!==null,scroll:0,selection:null,count:'',bytes:html?.length||0};
  if(n.loaded)node.innerHTML=sanitize(html);
  node.contentEditable=n.loaded?'true':'false';stack.append(pane);
  n.observer=new ResizeObserver(entries=>{n.height=entries[0].contentRect.height;if(active===n)stack.style.height=n.height+'px';});n.observer.observe(node);
  notes.set(noteId,n);return n;
 }
 function pending(n){return n.seq>n.saved;}
 function updateGuard(){post({type:pendingWrites.size?'dirty':'clean'});}
 function count(){
  clearTimeout(countTimer);if(!active)return;
  active.count=`${editor.textContent.length.toLocaleString()} 字`;
  document.getElementById('count').textContent=active.count;
 }
 function deferCount(){clearTimeout(countTimer);countTimer=setTimeout(count,300);}
 function dispose(n){clearTimeout(n.timer);n.observer.disconnect();n.pane.remove();}
 function resetCache(generation,account){
  if(generation<cacheGeneration)return;
  if(generation===cacheGeneration&&account===cacheAccount)return;
  const changed=cacheAccount!==null&&account!==cacheAccount;
  cacheGeneration=generation;cacheAccount=account;warmups.clear();syncRequested=false;
  if(changed&&active){active.pane.classList.remove('active');active.pane.setAttribute('aria-hidden','true');editor.removeAttribute('id');active=null;id='';selection=null;document.getElementById('document').hidden=true;document.getElementById('empty').style.display='flex';}
  for(const [key,n]of notes){
   if(!changed)n.account=account;
   if(n!==active&&!pending(n)){dispose(n);notes.delete(key);}
  }
 }
 function scheduleWarm(){
  if(warmTimer!==null||!warmups.size)return;
  const run=()=>{
   warmTimer=null;
   if(composing||Date.now()-lastInput<300){scheduleWarm();return;}
   const entry=warmups.entries().next().value;if(!entry)return;
   const [key,event]=entry;warmups.delete(key);
   if(event.generation===cacheGeneration){
    let n=notes.get(key);
    if(n!==active&&(!n||!pending(n))){
     if(!n)n=record(key,event.title,event.html);
     else if(n.source!==event.html){n.node.innerHTML=sanitize(event.html);n.source=event.html;n.bytes=event.html.length;n.loaded=true;n.node.contentEditable='true';n.selection=null;}
     n.title=event.title;prune();
    }
   }
   scheduleWarm();
  };
  warmTimer=window.requestIdleCallback?requestIdleCallback(run):setTimeout(run,60);
 }
 function preload(event){
  if(event.generation!==cacheGeneration||typeof event.html!=='string'||event.html.length>512*1024)return;
  warmups.delete(event.id);warmups.set(event.id,event);
  while(warmups.size>8)warmups.delete(warmups.keys().next().value);
  scheduleWarm();
 }
 function finishSync(){if(syncRequested&&!pendingWrites.size){syncRequested=false;post({type:'save',id});}}
 function prune(){
  clearTimeout(pruneTimer);pruneTimer=setTimeout(()=>{
   let clean=[...notes.values()].filter(n=>n!==active&&!pending(n));
   let bytes=clean.reduce((sum,n)=>sum+n.bytes*2,0);
   while(clean.length>8||bytes>16*1024*1024){const n=clean.shift();if(!n)break;dispose(n);notes.delete(n.id);bytes-=n.bytes*2;}
  },500);
 }
 function activate(n){
  if(active===n)return;
  remember();if(active){active.scroll=scrollPosition;active.selection=selection;active.pane.classList.remove('active');active.pane.setAttribute('aria-hidden','true');}
  editor.removeAttribute('id');editor=n.node;editor.id='editor';active=n;id=n.id;selection=n.selection;
  n.pane.classList.add('active');n.pane.removeAttribute('aria-hidden');n.height=n.height||n.node.offsetHeight;stack.style.height=n.height+'px';
  notes.delete(id);notes.set(id,n);title.textContent=n.title;
  document.getElementById('document').hidden=false;document.getElementById('empty').style.display='none';
  document.getElementById('count').textContent=n.count;
  if(scrollPosition!==n.scroll){main.scrollTop=n.scroll;scrollPosition=n.scroll;}deferCount();prune();
 }
 function changed(){
  if(!active?.loaded)return;
  lastInput=Date.now();
  const wasPending=pendingWrites.size>0,wasNotePending=pending(active);if(active.seq===active.sent)active.due=performance.now()+1000;active.seq=++serial;pendingWrites.add(id);
  if(!wasNotePending)post({type:'editing',id});
  if(!wasPending)post({type:'dirty'});
  schedule(active);deferCount();
 }
 function schedule(n,delay=200){clearTimeout(n.timer);const wait=delay>200?delay:Math.min(delay,Math.max(0,(n.due||performance.now()+1000)-performance.now()));n.timer=setTimeout(()=>flush(n),wait);}
 function flush(n=active,retry=false){
  if(!n)return;clearTimeout(n.timer);
  if(n.seq>n.sent||(retry&&pending(n))){
   // This runs after the interaction task, including for detached, inactive editors.
   const html=n.node.innerHTML;n.bytes=html.length;n.source=html;n.sent=n.seq;
   post({type:'change',id:n.id,html,seq:n.seq});
  }
 }
 function flushAll(){for(const n of notes.values())if(pending(n))flush(n,true);}
 function barrier(fn){if(pendingWrites.size){pendingAction=fn;flushAll();}else fn();}
 function navigate(type,data={}){
  intent++;post({type:'navigation',intent,id:type==='open'?data.id:null});
  const cached=type==='open'&&notes.get(data.id)?.loaded===true;
  if(type==='open')activate(notes.get(data.id)||record(data.id,data.title||'正在打开…'));
  post({type,...data,intent,...(type==='open'?{cached}:{})});
 }
 function onEditor(type,fn){document.getElementById('document').addEventListener(type,e=>{
  if(e.target===editor||editor.contains(e.target))fn(e);
 },type==='blur');}
 function remember(){const s=getSelection();if(s.rangeCount&&editor.contains(s.anchorNode))selection=s.getRangeAt(0).cloneRange();}
 function restore(){editor.focus();if(selection&&editor.contains(selection.startContainer)){const s=getSelection();s.removeAllRanges();s.addRange(selection);}}
 function command(cmd,value){if(!id)return;restore();document.execCommand(cmd,false,value??null);remember();changed();}
 function insert(html){command('insertHTML',html);}
 function task(){insert('<div><input type="checkbox"><label>待办事项</label></div><p><br></p>');}
 function modal(kind,heading,content,buttons){
  if(dialog.open){if(dialogKind===kind&&kind==='login')dialog.close();else{dialogQueue.push(()=>modal(kind,heading,content,buttons));return;}}
  dialogKind=kind;document.getElementById('dialog-title').textContent=heading;body.replaceChildren(...content);actions.replaceChildren();
  for(const [label,handler,cls] of buttons){const b=text('button',label);b.type='button';if(cls)b.className=cls;b.onclick=()=>{if(handler?.()!==false)dialog.close();};actions.append(b);}
  dialog.showModal();
 }
 dialog.addEventListener('close',()=>{const old=dialogKind;dialogKind='';if(old==='login'&&!window.loginFinished)post({type:'logout'});queueMicrotask(()=>dialogQueue.shift()?.());});
 const cancel=['取消',()=>{}];
 function askNew(){remember();const input=document.createElement('input');input.placeholder='给笔记起个名字';input.maxLength=80;input.required=true;
  const submit=()=>{const name=input.value.trim();if(name)navigate('new',{title:name});};
  modal('new','新建笔记',[input],[cancel,['创建',submit,'primary']]);
  input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();if(input.value.trim()){dialog.close();submit();}}};setTimeout(()=>input.focus(),0);
 }
 function deleteNote(targetId=id,targetTitle=title.textContent){if(!targetId)return;modal('delete','删除笔记',[text('p',`“${targetTitle}”将从本机和 OneDrive 移除。此操作无法在应用内撤销。`)],[cancel,['确认删除',()=>barrier(()=>{const n=notes.get(targetId);if(n)dispose(n);notes.delete(targetId);navigate('delete',{id:targetId});}),'danger']]);}
 const tools=[['type-bold','加粗','bold'],['type-italic','斜体','italic'],['type-underline','下划线','underline'],['type-strikethrough','删除线','strikeThrough'],['code-slash','代码',()=>{const s=getSelection()?.toString()||'代码';const code=text('code',s);insert(code.outerHTML);}],null,
  [null,'一级标题',()=>command('formatBlock','h1'),'H1'],[null,'二级标题',()=>command('formatBlock','h2'),'H2'],[null,'三级标题',()=>command('formatBlock','h3'),'H3'],null,
  ['list-ul','无序列表','insertUnorderedList'],['list-ol','有序列表','insertOrderedList'],['check2-square','待办事项',task],['table','插入表格',()=>{
   remember();const rows=document.createElement('input'),cols=document.createElement('input');rows.type=cols.type='number';rows.min=cols.min='1';rows.max=cols.max='30';rows.value='3';cols.value='3';
   modal('table','插入表格',[text('p','行数 / 列数（1–30）'),rows,cols],[cancel,['插入',()=>{const r=Math.min(30,Math.max(1,Number(rows.value)||3)),c=Math.min(30,Math.max(1,Number(cols.value)||3));let h='<table><tbody>';for(let i=0;i<r;i++){h+='<tr>';for(let j=0;j<c;j++)h+=i===0?'<th>标题</th>':'<td><br></td>';h+='</tr>';}insert(h+'</tbody></table><p><br></p>');},'primary']]);
  }],null,['unindent','减少缩进','outdent'],['indent','增加缩进','indent'],['arrow-counterclockwise','撤销','undo'],['arrow-clockwise','重做','redo'],['eraser','清除格式','removeFormat']];
 const toolbar=document.getElementById('toolbar');
 for(const tool of tools){if(!tool){const s=document.createElement('span');s.className='separator';toolbar.append(s);continue;}const [icon,label,cmd,caption]=tool,b=document.createElement('button');b.title=label;b.setAttribute('aria-label',label);if(icon){const i=document.createElement('i');i.className=`bi bi-${icon}`;b.append(i);}else b.textContent=caption;b.onmousedown=e=>{e.preventDefault();remember();};b.onclick=()=>typeof cmd==='function'?cmd():command(cmd);toolbar.append(b);}
 document.getElementById('save').onclick=()=>action('save');
 document.getElementById('print').onclick=()=>{if(id)post({type:'print'});};
 document.getElementById('export').onclick=()=>{const n=active;if(n)setTimeout(()=>post({type:'export',id:n.id,title:n.title,html:n.node.innerHTML}),0);};
 onEditor('input',changed);
 onEditor('compositionstart',()=>{composing=true;});
 onEditor('compositionend',()=>{composing=false;changed();if(pendingLoad){const e=pendingLoad;pendingLoad=null;receive(e);}});
 onEditor('blur',()=>{remember();if(active&&pending(active))schedule(active,0);});
 document.addEventListener('selectionchange',remember);
 onEditor('change',e=>{if(e.target.matches('input[type=checkbox]')){e.target.toggleAttribute('checked',e.target.checked);changed();}});
 onEditor('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();if(safeURL(a.href))post({type:'link',url:a.href});}});
 onEditor('keydown',e=>{
  if(e.isComposing)return;
  if(e.key==='Tab'){const node=getSelection()?.anchorNode;const el=node?.nodeType===1?node:node?.parentElement;if(el?.closest('li')){e.preventDefault();command(e.shiftKey?'outdent':'indent');}return;}
  if(e.key!==' ')return;
  const s=getSelection();if(!s?.isCollapsed||!s.rangeCount||s.anchorNode.nodeType!==3)return;
  const node=s.anchorNode,offset=s.anchorOffset,prefix=node.textContent.slice(0,offset);
  const patterns={'#':['formatBlock','h1'],'##':['formatBlock','h2'],'###':['formatBlock','h3'],'-':['insertUnorderedList'],'*':['insertUnorderedList'],'1.':['insertOrderedList'],'>':['formatBlock','blockquote']};
  if(!patterns[prefix]&&!['[]','[ ]','- [ ]'].includes(prefix))return;
  e.preventDefault();const r=s.getRangeAt(0);r.setStart(node,0);r.setEnd(node,offset);s.removeAllRanges();s.addRange(r);document.execCommand('delete');selection=null;remember();if(patterns[prefix])command(...patterns[prefix]);else task();
 });
 onEditor('paste',e=>{
  const clipboard=e.clipboardData;if(!clipboard)return;e.preventDefault();remember();
  const image=[...clipboard.items].find(i=>i.type.startsWith('image/'));
  if(image){const file=image.getAsFile();if(!file||file.size>8*1024*1024){receive({type:'error',message:'图片最大支持 8 MB，请缩小后重试。'});return;}const target=id;const reader=new FileReader();reader.onload=()=>{if(target!==id)return;const img=document.createElement('img');img.src=reader.result;img.alt='粘贴的图片';insert(img.outerHTML);};reader.readAsDataURL(file);return;}
  const html=clipboard.getData('text/html'),plain=clipboard.getData('text/plain');if(html)insert(sanitize(html));else if(safeURL(plain.trim())){const a=text('a',plain.trim());a.href=plain.trim();insert(a.outerHTML);}else command('insertText',plain);
 });
 const menu=document.getElementById('context');
 const tableActions=[['在上方插入行','row-before'],['在下方插入行','row-after'],['在左侧插入列','col-before'],['在右侧插入列','col-after'],['删除行','delete-row'],['删除列','delete-col']];
 function tableAction(op){const cell=contextCell;if(!cell)return;const row=cell.parentElement,table=cell.closest('table'),index=cell.cellIndex;
  if(op.startsWith('row')){const next=document.createElement('tr');for(let i=0;i<row.cells.length;i++){const td=document.createElement('td');td.innerHTML='<br>';next.append(td);}if(op==='row-before')row.before(next);else row.after(next);}
  else if(op==='delete-row')row.remove();else for(const r of [...table.rows]){if(op==='delete-col')r.cells[index]?.remove();else{const td=document.createElement(r.parentElement.tagName==='THEAD'?'th':'td');td.innerHTML='<br>';r.insertBefore(td,r.cells[index+(op==='col-after'?1:0)]||null);}}
  if(!table.rows.length||![...table.rows].some(r=>r.cells.length))table.remove();menu.hidden=true;changed();
 }
 for(const [label,op]of tableActions){const b=text('button',label);b.onclick=()=>tableAction(op);menu.append(b);}
 onEditor('contextmenu',e=>{const cell=e.target.closest('td,th');if(!cell)return;e.preventDefault();contextCell=cell;menu.hidden=false;menu.style.left=Math.min(e.clientX,innerWidth-190)+'px';menu.style.top=Math.min(e.clientY,innerHeight-210)+'px';});
 document.addEventListener('mousedown',e=>{if(!menu.contains(e.target))menu.hidden=true;});
 document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.isComposing){if(e.key.toLowerCase()==='s'){e.preventDefault();if(window.cnoteTools?.workspace)window.cnoteTools.flush();else action('save');}if(e.key.toLowerCase()==='n'){e.preventDefault();action('new');}if(e.key.toLowerCase()==='q'){e.preventDefault();action('close');}if(e.key==='\\'){e.preventDefault();post({type:'sidebar'});}}});
 function action(type,data={}){
  if(composing){editor.blur();composing=false;}
  switch(type){
   case 'open': if(data.id!==id)navigate(type,data);break;
   case 'new':askNew();break;
   case 'delete':deleteNote(data.id,data.title);break;
   case 'focus':document.body.classList.toggle('focus');break;
   case 'save':setTimeout(()=>{window.cnoteTools?.flush();syncRequested=true;flushAll();finishSync();},0);break;
   case 'close':case 'login':case 'logout':(window.cnoteTools?.barrier||((next)=>next()))(()=>barrier(()=>{
    if(type==='logout'){warmups.clear();syncRequested=false;for(const n of notes.values())dispose(n);notes.clear();}
    navigate(type,data);
   }));break;
   default:post({type,id,...data});
  }
 }
 function receive(e){
  switch(e.type){
   case 'theme':window.cnoteTheme.set(e.theme);break;
   case 'cache_reset':resetCache(e.generation,e.account);break;
   case 'preload':preload(e);break;
   case 'tool_state':case 'tool_saved':case 'tool_save_failed':window.cnoteTools?.receive(e);break;
   case 'load':{
    if(e.intent!==undefined&&e.intent<intent)return;
    if(composing){pendingLoad=e;return;}
    if(!e.id){
     if(active){active.pane.classList.remove('active');active.pane.setAttribute('aria-hidden','true');}active=null;id='';selection=null;editor.removeAttribute('id');
     document.getElementById('document').hidden=true;document.getElementById('empty').style.display='flex';break;
    }
    let n=notes.get(e.id);
    if(n&&pending(n)){activate(n);return;}
    if(!n)n=record(e.id,e.title,e.html);
    else if(!n.loaded||n.source!==e.html){
     n.node.innerHTML=sanitize(e.html);n.source=e.html;n.bytes=e.html.length;n.loaded=true;n.node.contentEditable='true';n.selection=null;
    }
    n.title=e.title;activate(n);title.textContent=n.title;deferCount();break;
   }
   case 'saved':{
    const n=notes.get(e.id);if(!n)break;
    n.saved=Math.max(n.saved,Math.min(n.seq,e.seq));
    if(!pending(n)){pendingWrites.delete(n.id);post({type:'settled',id:n.id});prune();}
    if(!pendingWrites.size){updateGuard();if(pendingAction){const next=pendingAction;pendingAction=null;queueMicrotask(next);}}
    if(syncRequested){for(const note of notes.values())if(note.seq>note.sent)flush(note);finishSync();}
    if(n!==active&&!pending(n)&&n.account!==cacheAccount){dispose(n);notes.delete(n.id);}
    if(n===active){document.getElementById('status').textContent='已保存到本机';document.getElementById('status').style.color='';}
    break;
   }
   case 'save_failed':{
    syncRequested=false;
    const n=notes.get(e.id);if(n&&e.seq>n.saved){n.sent=n.saved;pendingAction=null;schedule(n,3000);}
    document.getElementById('status').textContent=`${n?.title||'笔记'}：保存失败，草稿保留在内存中，将自动重试。${e.message}`;
    document.getElementById('status').style.color='#ca5262';break;
   }
   case 'state':if(e.cache_generation!==undefined)resetCache(e.cache_generation,e.cache_account);if(e.intent===undefined||e.intent>=intent){document.getElementById('status').textContent=e.status;document.getElementById('status').style.color='';}break;
   case 'error':document.getElementById('status').textContent=e.message;document.getElementById('status').style.color='#ca5262';break;
   case 'dialog':{
    const d=e.data;
    if(e.kind==='login_done'){window.loginFinished=true;if(dialogKind==='login')dialog.close();return;}
    if(e.kind==='login'){window.loginFinished=false;const code=text('div',d.code);code.className='login-code';modal('login','连接 OneDrive',[text('p','在浏览器中登录 Microsoft 账号，并输入以下设备码。'),code],[['取消登录',()=>post({type:'logout'})],['打开 Microsoft 登录',()=>{post({type:'link',url:d.url});return false;},'primary']]);post({type:'link',url:d.url});}
    if(e.kind==='large_change')modal('large_change','内容变动较大',[text('p',`“${d.title}”的大部分内容已被替换或删除。本地草稿已经保存，是否将修改同步到 OneDrive？`)],[['暂不同步',()=>{}],['确认同步',()=>post({type:'approve',id:d.id,revision:d.revision}),'primary']]);
    if(e.kind==='conflict')modal('conflict','检测到版本冲突',[text('p',`“${d.title}”在其他设备上已有修改。选择要保留的版本，或取消后先导出当前草稿。`)],[cancel,['使用云端版本',()=>{barrier(()=>{const n=notes.get(d.id);if(n)dispose(n);notes.delete(d.id);post({type:'resolve',id:d.id,choice:'cloud'});});} ],['保留我的修改',()=>{barrier(()=>post({type:'resolve',id:d.id,choice:'mine'}));},'primary']]);
    break;
   }
  }
 }
 window.cnote={action,receive,flush,sanitize,focusEditor:restore};post({type:'ready'});
})();
