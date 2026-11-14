'use strict';
(() => {
 let editor=document.getElementById('editor');
 const title=document.getElementById('title'), editorTemplate=editor.cloneNode(false), main=document.querySelector('main');
 editorTemplate.classList.add('note-editor');editorTemplate.removeAttribute('id');
 const stack=document.createElement('div');stack.className='editor-stack';editor.replaceWith(stack);
 const dialog=document.getElementById('dialog'), body=document.getElementById('dialog-body'), actions=document.getElementById('dialog-actions');
 let id='',active=null,serial=0,intent=0,selection=null,contextCell=null,selectedImage=null,imageRequest=0,imagePending=null;
 const notes=new Map(),pendingWrites=new Set();
 const pastedLinks=new Map();let linkToken=0;
 const warmups=new Map();let warmTimer=null,cacheGeneration=0,cacheAccount=null,lastInput=0,syncRequested=false;
 let countTimer=null,pruneTimer=null,scrollPosition=0;
 main.addEventListener('scroll',()=>{scrollPosition=main.scrollTop;if(active)active.scroll=scrollPosition;positionImageActions();paintFind();},{passive:true});
 let composing=false,pendingLoad=null,dialogKind='',dialogQueue=[],pendingAction=null,pendingConflictResult=null;
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
 function dispose(n){clearTimeout(n.timer);n.observer.disconnect();n.pane.remove();for(const [token,request]of pastedLinks)if(request.note===n)pastedLinks.delete(token);}
 function resetCache(generation,account){
  if(generation<cacheGeneration)return;
  if(generation===cacheGeneration&&account===cacheAccount)return;
  const changed=cacheAccount!==null&&account!==cacheAccount;
  cacheGeneration=generation;cacheAccount=account;warmups.clear();syncRequested=false;
  if(changed)clearImageSelection();
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
  closeFind(false);
  remember();clearImageSelection();if(active){active.scroll=scrollPosition;active.selection=selection;active.pane.classList.remove('active');active.pane.setAttribute('aria-hidden','true');}
  editor.removeAttribute('id');editor=n.node;editor.id='editor';active=n;id=n.id;selection=n.selection;
  n.pane.classList.add('active');n.pane.removeAttribute('aria-hidden');n.height=n.height||n.node.offsetHeight;stack.style.height=n.height+'px';
  notes.delete(id);notes.set(id,n);title.textContent=n.title;
  document.getElementById('document').hidden=false;document.getElementById('empty').style.display='none';
  document.getElementById('count').textContent=n.count;
  if(scrollPosition!==n.scroll){main.scrollTop=n.scroll;scrollPosition=n.scroll;}deferCount();prune();
  if(pastedLinks.size)setTimeout(applyLinkTitles,0);
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
 },type==='blur'||type==='load');}
 function remember(){const s=getSelection();if(s.rangeCount&&editor.contains(s.anchorNode))selection=s.getRangeAt(0).cloneRange();syncImageSelection();}
 function restore(){editor.focus();if(selection&&editor.contains(selection.startContainer)){const s=getSelection();s.removeAllRanges();s.addRange(selection);}}
 const imageOutline=document.getElementById('image-selection'),imageActions=document.getElementById('image-actions');
 function clearImageSelection(){selectedImage=null;imageOutline.hidden=true;imageActions.hidden=true;}
 function syncImageSelection(){
  const s=getSelection(),r=s?.rangeCount?s.getRangeAt(0):null;
  const node=r&&r.startContainer===r.endContainer&&r.endOffset===r.startOffset+1?r.startContainer.childNodes[r.startOffset]:null;
  selectedImage=node?.nodeName==='IMG'&&editor.contains(node)?node:null;positionImageActions();
 }
 function positionImageActions(){
  if(!selectedImage?.isConnected||!editor.contains(selectedImage)||dialog.open||window.cnoteTools?.workspace){imageOutline.hidden=true;imageActions.hidden=true;return;}
  const r=selectedImage.getBoundingClientRect(),bounds=main.getBoundingClientRect();
  const top=Math.max(r.top,bounds.top),bottom=Math.min(r.bottom,bounds.bottom),left=Math.max(r.left,0),right=Math.min(r.right,innerWidth);
  if(bottom<=top||right<=left){imageOutline.hidden=true;imageActions.hidden=true;return;}
  imageOutline.hidden=false;imageActions.hidden=false;
  Object.assign(imageOutline.style,{left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});
  imageActions.style.left=Math.max(8,Math.min(left,innerWidth-imageActions.offsetWidth-8))+'px';
  imageActions.style.top=Math.max(bounds.top+6,top-imageActions.offsetHeight-8)+'px';
  for(const button of imageActions.querySelectorAll('button'))button.disabled=!!imagePending;
 }
 function selectImage(image){
  editor.focus();const range=document.createRange();range.selectNode(image);const s=getSelection();s.removeAllRanges();s.addRange(range);remember();
 }
 function imageStatus(message,error=false){const status=document.getElementById('status');status.textContent=message;status.style.color=error?'#ca5262':'';}
 function imageClipboard(cut=false){
  if(!selectedImage||imagePending)return;
  const image=selectedImage,src=image.getAttribute('src');if(!src){imageStatus('图片地址无效，无法复制。',true);return;}
  imagePending={token:++imageRequest,id,image,src,cut};positionImageActions();
  imageStatus(cut?'正在复制图片，成功后从笔记移除…':'正在复制图片…');
  post({type:'image_clipboard',token:imageRequest,src,html:image.outerHTML});
 }
 function removeImage(image=selectedImage){
  if(!image||!editor.contains(image))return false;
  selectImage(image);const removed=document.execCommand('delete');remember();
  if(removed){changed();clearImageSelection();}return removed;
 }
 function viewImage(image=selectedImage){
  if(!image)return;
  const frame=document.createElement('div'),full=document.createElement('img'),info=text('p','滚动查看图片 · Esc 关闭');
  frame.className='image-view-frame';full.src=image.src;full.alt=image.alt||'笔记图片';frame.append(full);
  let zoom=1;
  const scale=value=>{zoom=Math.max(.001,Math.min(4,value));if(full.naturalWidth)full.style.width=Math.round(full.naturalWidth*zoom)+'px';info.textContent=`${full.naturalWidth} × ${full.naturalHeight} · ${Math.round(zoom*100)}% · Esc 关闭`;};
  const fit=()=>scale(Math.min(1,(frame.clientWidth-16)/full.naturalWidth,(frame.clientHeight-16)/full.naturalHeight));
  full.onload=fit;full.onerror=()=>{info.textContent='图片加载失败，请检查网络后重试。';};
  modal('image','查看图片',[info,frame],[['缩小',()=>{scale(zoom/1.25);return false;}],['放大',()=>{scale(zoom*1.25);return false;}],['原始尺寸',()=>{scale(1);return false;}],['适应窗口',()=>{fit();return false;}],['关闭',()=>{},'primary']]);
  positionImageActions();requestAnimationFrame(()=>{if(full.complete&&full.naturalWidth)fit();});
 }
 imageActions.addEventListener('mousedown',e=>e.preventDefault());
 for(const button of imageActions.querySelectorAll('button'))button.onclick=()=>{
  const action=button.dataset.imageAction;if(action==='view')viewImage();else if(action==='delete')removeImage();else imageClipboard(action==='cut');
 };
 window.addEventListener('resize',positionImageActions);
 onEditor('load',positionImageActions);
 onEditor('mousedown',e=>{if(e.button===0&&e.target.tagName==='IMG'){e.preventDefault();selectImage(e.target);}});
 onEditor('dblclick',e=>{if(e.target.tagName==='IMG'){e.preventDefault();selectImage(e.target);viewImage(e.target);}});
 for(const type of ['copy','cut'])onEditor(type,e=>{syncImageSelection();if(selectedImage){e.preventDefault();imageClipboard(type==='cut');}});
 function command(cmd,value){if(!id)return;restore();document.execCommand(cmd,false,value??null);remember();changed();}
 const shortcuts=[
  ['bold','加粗','b'],['italic','斜体','i'],['underline','下划线','u'],['strikeThrough','删除线','x',true],
  ['inlineCode','行内代码','e'],['codeBlock','代码块','c',true],['link','插入或编辑链接','k'],['unlink','移除链接','k',true],
  ['paragraph','正文','0',false,true],['heading1','一级标题','1',false,true],['heading2','二级标题','2',false,true],['heading3','三级标题','3',false,true],
  ['insertOrderedList','有序列表','7',true],['insertUnorderedList','无序列表','8',true],['task','待办事项','9',true],['quote','引用','b',true],
  ['outdent','减少缩进','['],['indent','增加缩进',']'],['removeFormat','清除格式','\\',true],
  ['justifyLeft','左对齐','l',true],['justifyCenter','居中','e',true],['justifyRight','右对齐','r',true],['justifyFull','两端对齐','j',true],
  ['table','插入表格','t',false,true],['pastePlain','粘贴为纯文本','v',true],
  ['find','查找当前笔记','f'],['findNext','下一个匹配','g'],['findPrevious','上一个匹配','g',true],['print','打印','p'],['shortcuts','快捷键说明','/'],
 ].map(([id,label,key,shift=false,alt=false])=>({id,label,key,shift,alt,display:'⌘'+(alt?'⌥':'')+(shift?'⇧':'')+key.toUpperCase()}));
 let plainPaste=false,plainPasteTimer=null;
 function noteFocused(){return active?.loaded&&!dialog.open&&!composing&&!window.cnoteTools?.workspace&&document.activeElement===editor&&editor.contains(getSelection()?.anchorNode);}
 function closestBlock(){const node=getSelection()?.anchorNode;return (node?.nodeType===1?node:node?.parentElement)?.closest('h1,h2,h3,p,pre,blockquote');}
 function block(tag){command('formatBlock',closestBlock()?.tagName.toLowerCase()===tag?'p':tag);}
 function inlineCode(){
  const node=getSelection()?.anchorNode,code=(node?.nodeType===1?node:node?.parentElement)?.closest('code');
  if(code&&editor.contains(code)){const parent=code.parentElement,copy=parent.cloneNode(true),index=[...parent.childNodes].indexOf(code),plain=copy.childNodes[index];plain.replaceWith(...plain.childNodes);const r=document.createRange();if(parent===editor)r.selectNodeContents(parent);else r.selectNode(parent);selection=r;insert(parent===editor?copy.innerHTML:copy.outerHTML);}
  else {const code=text('code',getSelection()?.toString().replace(/\n+$/,'')||'代码');insert(code.outerHTML);}
 }
 function linkDialog(){
  remember();const node=selection?.startContainer,anchor=(node?.nodeType===1?node:node?.parentElement)?.closest('a');
  if(anchor&&editor.contains(anchor)){const r=document.createRange();r.selectNodeContents(anchor);selection=r;}
  const input=document.createElement('input');input.type='url';input.placeholder='https://example.com';input.setAttribute('aria-label','链接地址');input.value=anchor?.getAttribute('href')||'';
  const linkRange=selection?.cloneRange(),error=text('p',''),apply=()=>{const url=input.value.trim();if(!safeURL(url)){error.textContent='请输入有效的 http、https 或 mailto 链接';input.focus();return false;}dialog.close();selection=linkRange?.cloneRange();if(selection&&!selection.collapsed)command('createLink',url);else{const a=text('a',url);a.href=url;insert(a.outerHTML);}};
  modal('link','插入或编辑链接',[input,error],[cancel,['移除链接',()=>{dialog.close();selection=linkRange?.cloneRange();command('unlink');}],['保存',apply,'primary']]);
  input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();apply();}};input.focus();input.select();
 }
 function showShortcuts(){
  remember();const list=document.createElement('div');list.className='shortcut-help';list.tabIndex=0;list.setAttribute('role','region');list.setAttribute('aria-label','快捷键列表');
  const basics=[['撤销 / 重做','⌘Z / ⌘⇧Z'],['剪切 / 复制 / 粘贴 / 全选','⌘X / ⌘C / ⌘V / ⌘A'],['新建 / 保存笔记','⌘N / ⌘S'],['切换工作区','⌘1–⌘6'],['列表缩进 / 表格内移动','Tab / ⇧Tab'],['关闭查找 / 弹窗','Esc']];
  for(const [label,key] of [...shortcuts.map(s=>[s.label,s.display]),...basics]){const row=document.createElement('div');row.append(text('span',label),text('kbd',key));list.append(row);}
  modal('shortcuts','笔记快捷键',[list],[['关闭',()=>{}]]);
 }
 function formatShortcut(cmd){
  if(!shortcuts.some(s=>s.id===cmd))return false;
  if(cmd==='find'&&!findBar.hidden&&findBar.contains(document.activeElement)){findInput.focus();findInput.select();return true;}
  if(['findNext','findPrevious'].includes(cmd)&&!findBar.hidden&&!dialog.open&&!window.cnoteTools?.workspace&&(noteFocused()||findBar.contains(document.activeElement))){findNote(cmd==='findNext'?1:-1);return true;}
  if(!noteFocused())return false;
  remember();
  if(cmd==='inlineCode')inlineCode();else if(cmd==='codeBlock')block('pre');else if(cmd==='quote')block('blockquote');
  else if(cmd==='paragraph')command('formatBlock','p');else if(/^heading[1-3]$/.test(cmd))block('h'+cmd.at(-1));
  else if(cmd==='task')task();else if(cmd==='link')linkDialog();else if(cmd==='table')insertTableDialog();
  else if(cmd==='find')openFind();else if(cmd==='findNext'||cmd==='findPrevious'){openFind();findNote(cmd==='findNext'?1:-1);}
  else if(cmd==='shortcuts')showShortcuts();else if(cmd==='print')post({type:'print'});
  else if(cmd==='pastePlain'){plainPaste=true;clearTimeout(plainPasteTimer);plainPasteTimer=setTimeout(()=>plainPaste=false,1000);}
  else command(cmd);return true;
 }
 function pastePlain(value){if(!noteFocused())return false;if(!value)return true;remember();command('insertText',value);plainPaste=false;return true;}
 function keyShortcut(e){
  if(e.isComposing||!(e.metaKey||e.ctrlKey)||(e.metaKey&&e.ctrlKey))return false;
  const key={BracketLeft:'[',BracketRight:']',Backslash:'\\',Slash:'/'}[e.code]||(/^Digit[0-9]$/.test(e.code)?e.code.slice(-1):e.altKey&&/^Key[A-Z]$/.test(e.code)?e.code.slice(-1).toLowerCase():e.key.toLowerCase());
  const shortcut=shortcuts.find(s=>s.key===key&&s.shift===e.shiftKey&&s.alt===e.altKey);
  if(!shortcut||!formatShortcut(shortcut.id))return false;
  if(shortcut.id!=='pastePlain')e.preventDefault();return true;
 }
 function insert(html){command('insertHTML',html);}
 function task(){const label=text('label',getSelection()?.toString().trim()||'待办事项');insert('<div><input type="checkbox">'+label.outerHTML+'</div><p><br></p>');}
 const findBar=document.createElement('div'),findInput=document.createElement('input'),findCount=text('span','0 / 0');
 findBar.id='note-find';findBar.hidden=true;findInput.type='search';findInput.placeholder='查找当前笔记';findInput.setAttribute('aria-label','查找当前笔记');findCount.setAttribute('aria-live','polite');findBar.append(findInput,findCount);
 const findMarks=document.createElement('div');findMarks.id='note-find-marks';document.body.append(findMarks);
 let findIndex=-1,findQuery='',findRange=null;
 for(const [label,handler] of [['上一个',()=>findNote(-1)],['下一个',()=>findNote(1)],['关闭查找',()=>closeFind(true)]]){const button=text('button',label);button.type='button';button.onclick=handler;findBar.append(button);}
 document.querySelector('header').append(findBar);
 function closeFind(focus){const range=findRange;findBar.hidden=true;findIndex=-1;findQuery='';findRange=null;findMarks.replaceChildren();if(focus){if(range&&editor.contains(range.startContainer))selection=range;restore();}}
 function paintFind(){
  findMarks.replaceChildren();if(findBar.hidden||!findRange||!editor.contains(findRange.startContainer))return;
  const bounds=main.getBoundingClientRect();for(const rect of findRange.getClientRects()){const top=Math.max(rect.top,bounds.top),bottom=Math.min(rect.bottom,bounds.bottom);if(bottom<=top)continue;const mark=document.createElement('div');mark.className='note-find-mark';Object.assign(mark.style,{left:Math.max(rect.left,bounds.left)+'px',top:top+'px',width:Math.max(0,Math.min(rect.right,bounds.right)-Math.max(rect.left,bounds.left))+'px',height:bottom-top+'px'});findMarks.append(mark);}
 }
 window.addEventListener('resize',paintFind);
 function openFind(){const selected=getSelection()?.toString();if(selected&&selected.length<=256)findInput.value=selected;findBar.hidden=false;findIndex=-1;findInput.focus();findInput.select();if(findInput.value)findNote(1);}
 function findNote(direction){
  const keepFocus=findBar.contains(document.activeElement),query=findInput.value;if(!query){findCount.textContent='0 / 0';findIndex=-1;findRange=null;paintFind();return;}
  const nodes=[],walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let value='',node;
  while((node=walker.nextNode())){nodes.push({node,start:value.length,end:value.length+node.data.length});value+=node.data;}
  const escaped=Array.from(query,char=>'^$\\.*+?()[]{}|'.includes(char)?'\\'+char:char).join(''),pattern=new RegExp(escaped,'giu'),matches=[...value.matchAll(pattern)];
  if(!matches.length){findCount.textContent='0 / 0';findIndex=-1;findRange=null;paintFind();return;}
  if(findQuery!==query||findIndex<0)findIndex=direction>0?0:matches.length-1;else findIndex=(findIndex+direction+matches.length)%matches.length;
  findQuery=query;const match=matches[findIndex],start=nodes.find(n=>n.end>match.index),end=nodes.find(n=>n.end>=match.index+match[0].length),range=document.createRange();
  range.setStart(start.node,match.index-start.start);range.setEnd(end.node,match.index+match[0].length-end.start);const s=getSelection();s.removeAllRanges();s.addRange(range);findRange=range.cloneRange();selection=range.cloneRange();if(keepFocus)findInput.focus({preventScroll:true});
  start.node.parentElement.scrollIntoView({block:'center'});findCount.textContent=`${findIndex+1} / ${matches.length}`;paintFind();
 }
 findInput.oninput=()=>{findIndex=-1;findNote(1);};
 findInput.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();findNote(e.shiftKey?-1:1);}};
 document.addEventListener('keydown',e=>{if(e.defaultPrevented||e.isComposing)return;if(e.key==='Escape'&&!findBar.hidden){e.preventDefault();closeFind(true);return;}if(findBar.contains(e.target))keyShortcut(e);});
 function tableTab(backwards){
  const node=getSelection()?.anchorNode,cell=(node?.nodeType===1?node:node?.parentElement)?.closest('td,th');if(!cell||!editor.contains(cell))return false;
  const table=cell.closest('table'),cells=[...table.rows].flatMap(row=>[...row.cells]),index=cells.indexOf(cell);let target=cells[index+(backwards?-1:1)];
  if(!target&&!backwards){
   const copy=table.cloneNode(true),width=[...table.rows[table.rows.length-1].cells].reduce((n,c)=>n+c.colSpan,0),row=copy.insertRow(-1);
   for(let i=0;i<width;i++){const td=document.createElement('td');td.innerHTML='<br>';row.append(td);}
   const parent=table.parentNode,index=[...parent.childNodes].indexOf(table),range=document.createRange();editor.blur();editor.focus();range.selectNode(table);selection=range;insert(copy.outerHTML);target=parent.childNodes[index]?.rows?.[copy.rows.length-1]?.cells[0];
  }
  if(!target)return false;editor.focus();const r=document.createRange();r.selectNodeContents(target);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);remember();return true;
 }
 function modal(kind,heading,content,buttons){
  if(dialog.open){if(dialogKind===kind&&kind==='login')dialog.close();else{dialogQueue.push(()=>modal(kind,heading,content,buttons));return;}}
  dialogKind=kind;dialog.classList.toggle('conflict-dialog',kind==='conflict');dialog.classList.toggle('image-dialog',kind==='image');document.getElementById('dialog-title').textContent=heading;body.replaceChildren(...content);actions.replaceChildren();
  for(const [label,handler,cls] of buttons){const b=text('button',label);b.type='button';if(cls)b.className=cls;b.onclick=()=>{if(handler?.()!==false)dialog.close();};actions.append(b);}
  dialog.showModal();
 }
 dialog.addEventListener('cancel',e=>{if(pendingConflictResult)e.preventDefault();});
 dialog.addEventListener('close',()=>{const old=dialogKind;dialogKind='';if(old==='login'&&!window.loginFinished)post({type:'logout'});queueMicrotask(()=>{positionImageActions();dialogQueue.shift()?.();});});
 const cancel=['取消',()=>{}];
 function conflictDialog(d){
  if(dialog.open){dialogQueue.push(()=>conflictDialog(d));return;}
  // A conflict may arrive before an editor's debounced write has reached storage.
  barrier(()=>post({type:'conflict_view',id:d.id}));
 }
 function showConflict(d){
  if(dialog.open){dialogQueue.push(()=>showConflict(d));return;}
  const local=notes.get(d.id),left=local?.loaded?(pending(local)?local.node.innerHTML:local.source??local.node.innerHTML):d.local;
  const intro=text('p','点击差异旁的 → 或 ← 采用对应内容');intro.className='conflict-hint';
  const summary=text('p','正在计算差异…'),changes=document.createElement('div'),preview=document.createElement('div');
  changes.className='conflict-changes';preview.className='note-editor conflict-preview';preview.setAttribute('aria-label','合并结果预览');
  preview.addEventListener('click',e=>e.preventDefault());changes.addEventListener('click',e=>{if(e.target.closest('a,input'))e.preventDefault();});
  const label=document.createElement('details'),sourceToggle=text('button','查看内容差异'),toolbar=document.createElement('div');sourceToggle.type='button';
  label.className='conflict-preview-toggle';label.append(text('summary','笔记预览'),preview);toolbar.className='conflict-toolbar';toolbar.append(summary,sourceToggle);
  let source=true,groups=[],ready=false,completed=false,save;
  const render=()=>{
   const fragment=document.createDocumentFragment();let count=0;
   const headings=document.createElement('div');headings.className='conflict-columns conflict-headings';
   headings.append(text('strong','本地'),text('span',''),text('strong','合并结果'),text('span',''),text('strong','云端'));fragment.append(headings);
   const lineNumbers={mine:1,result:1,cloud:1};
   const content=html=>{
    const node=document.createElement(source?'pre':'div');node.className='conflict-content';
    if(source){
     const code=(html||'').replace(/(<\/(?:div|p|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>)(?=<)/gi,'$1\n');
     for(const token of code.match(/<[^>]*>|[^<]+|</g)||[]){const part=text('span',token);if(token.startsWith('<'))part.className='conflict-tag';node.append(part);}
    }else if(html)node.innerHTML=sanitize(html);else node.textContent='（此处无内容）';
    return node;
   };
   const fill=(pane,html,side)=>{
    const node=content(html);
    if(source){
     const lines=node.textContent.split('\n');node.replaceChildren();
     for(const [index,line] of lines.entries()){
      const row=document.createElement('span'),number=document.createElement('span'),code=document.createElement('span');row.className='conflict-code-row';number.className='conflict-line-numbers';number.setAttribute('aria-hidden','true');number.dataset.line=html?String(lineNumbers[side]++):'';code.className='conflict-code-text';
      for(const token of line.match(/<[^>]*>|[^<]+|</g)||[]){const part=text('span',token);if(token.startsWith('<'))part.className='conflict-tag';code.append(part);}
      if(index<lines.length-1)code.append(document.createTextNode('\n'));row.append(number,code);node.append(row);
     }
     pane.append(node);
    }else{
     const number=document.createElement('span');number.className='conflict-line-numbers';number.setAttribute('aria-hidden','true');number.dataset.line=html?String(lineNumbers[side]++):'';pane.append(number,node);
    }
   };
   for(const group of groups){
    const section=document.createElement('section'),columns=document.createElement('div');columns.className='conflict-columns';
    if(group.same!==undefined){
     section.className='conflict-context';
     for(const name of ['mine','result','cloud']){const pane=document.createElement('div');pane.className='conflict-version '+name;fill(pane,group.same,name);columns.append(pane);if(name!=='cloud')columns.append(text('span',''));}
    }else{
     section.className='conflict-change';
     section.setAttribute('aria-label',`差异 ${++count} · ${group.choice==='mine'?'保留本地':group.choice==='cloud'?'使用云端':'待你选择'}`);
     const changeIndex=count-1;
     const pane=choice=>{const node=document.createElement('div');node.className='conflict-version '+choice;node.classList.toggle('selected',group.choice===choice);fill(node,group[choice],choice);return node;};
     const arrow=choice=>{
      const heading=choice==='mine'?'本地':'云端',button=text('button',choice==='mine'?'→':'←');button.type='button';button.className='conflict-arrow '+choice;
      button.setAttribute('aria-label',`选择${heading}`);button.setAttribute('aria-pressed',String(group.choice===choice));button.title=`差异 ${count} · ${group.choice===choice?'已选：':''}采用${heading}内容`;
      button.onclick=()=>{
       if(pendingConflictResult)return;
       const focused=document.activeElement===button;group.choice=choice;render();
       if(focused)changes.querySelectorAll('.conflict-change')[changeIndex]?.querySelector(`.conflict-arrow.${choice}`)?.focus({preventScroll:true});
      };const gutter=document.createElement('span');gutter.className='conflict-gutter';gutter.append(button);return gutter;
     };
     const result=document.createElement('div');result.className='conflict-version result';result.setAttribute('aria-label',`差异 ${count} 的合并结果`);
     if(group.choice){result.classList.add('resolved');result.title=group.choice==='mine'?'已采用本地':'已采用云端';fill(result,group[group.choice],'result');}
     else {result.classList.add('unresolved');result.append(text('span',`差异 ${count} · 待选择`));}
     columns.append(pane('mine'),arrow('mine'),result,arrow('cloud'),pane('cloud'));
    }
    section.append(columns);fragment.append(section);
   }
   const tail=document.createElement('div');tail.className='conflict-columns conflict-tail';
   for(let column=0;column<5;column++)tail.append(document.createElement(column%2?'span':'div'));fragment.append(tail);
   const scrollTop=changes.scrollTop,scrollLeft=changes.scrollLeft;changes.replaceChildren(fragment);changes.scrollTop=scrollTop;changes.scrollLeft=scrollLeft;
   const differences=groups.filter(g=>g.same===undefined),unselected=differences.filter(g=>!g.choice).length;
   const mine=differences.filter(g=>g.choice==='mine').length,cloud=differences.filter(g=>g.choice==='cloud').length;
   preview.innerHTML=unselected?'':sanitize(groups.map(g=>g.same??g[g.choice]).join(''));
   if(unselected)preview.textContent=`还有 ${unselected} 处差异待选择，全部选择后显示完整结果。`;
   summary.textContent=count?`共 ${count} 处差异 · 本地 ${mine} 处 · 云端 ${cloud} 处 · 待选择 ${unselected} 处`:'内容一致（包含格式）';
   save.disabled=!ready||unselected>0;
  };
  sourceToggle.onclick=()=>{source=!source;sourceToggle.textContent=source?'查看内容差异':'查看 HTML 差异';render();};
  const resolve=(choice,html)=>{
   const selection=choice==='cloud'?'整篇使用云端版本':choice==='mine'?'整篇保留本地版本':groups.filter(g=>g.same===undefined).map((g,i)=>`差异 ${i+1}：${g.choice==='mine'?'保留本地':'使用云端'}`).join('；');
   summary.textContent='正在保存你的选择…';for(const button of dialog.querySelectorAll('button'))button.disabled=true;
   pendingConflictResult={id:d.id,receive:result=>{
    pendingConflictResult=null;
    if(!result.ok){
     for(const button of dialog.querySelectorAll('button'))button.disabled=false;
     summary.textContent=`未能保存选择：${result.message}。原有草稿仍保留，请稍后重新打开对比。`;
     save.disabled=!ready||groups.some(g=>g.same===undefined&&!g.choice);return;
    }
    completed=true;document.getElementById('dialog-title').textContent='已应用你的选择';
    const resultPreview=document.createElement('div');resultPreview.className='note-editor conflict-preview';resultPreview.setAttribute('aria-label','已保存的笔记内容');resultPreview.innerHTML=sanitize(result.html);resultPreview.addEventListener('click',e=>e.preventDefault());
    body.replaceChildren(text('p',selection),text('p',result.pending_sync?'已保存到本机，等待同步到 OneDrive。':'已使用云端版本并保存到本机。'),text('h3','最终保存内容'),resultPreview);
    const done=text('button','完成');done.type='button';done.className='primary';done.onclick=()=>dialog.close();actions.replaceChildren(done);done.focus();
   }};
   barrier(()=>post({type:'resolve',id:d.id,choice,html,revision:d.revision,etag:d.etag}));
   return false;
  };
  modal('conflict',`合并冲突 · ${d.title}`,[toolbar,intro,changes,label],[['稍后处理',()=>{}],['使用云端版本',()=>resolve('cloud')],['保留本地版本',()=>resolve('mine')],['保存合并结果',()=>{if(!ready||groups.some(g=>g.same===undefined&&!g.choice))return false;return resolve('merge',groups.map(g=>g.same??g[g.choice]).join(''));},'primary']]);
  save=actions.lastElementChild;save.disabled=true;
  window.cnoteTools.compareNote({left:left??'',right:d.cloud}).then(parts=>{
   for(const part of parts){
    if(part.kind==='same')groups.push({same:part.html});
    else {let group=groups.at(-1);if(!group||group.same!==undefined){group={mine:'',cloud:'',choice:null};groups.push(group);}group[part.kind==='removed'?'mine':'cloud']+=part.html;}
   }
   ready=true;if(completed||pendingConflictResult?.id===d.id)return;render();
  }).catch(error=>{if(!completed&&pendingConflictResult?.id!==d.id)summary.textContent=`无法计算差异：${error.message}。仍可选择整篇版本。`;});
 }
 function askNew(){remember();const input=document.createElement('input');input.placeholder='给笔记起个名字';input.maxLength=80;input.required=true;
  const submit=()=>{const name=input.value.trim();if(name)navigate('new',{title:name});};
  modal('new','新建笔记',[input],[cancel,['创建',submit,'primary']]);
  input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();if(input.value.trim()){dialog.close();submit();}}};setTimeout(()=>input.focus(),0);
 }
 function deleteNote(targetId=id,targetTitle=title.textContent){if(!targetId)return;modal('delete','删除笔记',[text('p',`“${targetTitle}”将从本机和 OneDrive 移除。此操作无法在应用内撤销。`)],[cancel,['确认删除',()=>barrier(()=>{const n=notes.get(targetId);if(n)dispose(n);notes.delete(targetId);navigate('delete',{id:targetId});}),'danger']]);}
 function insertTableDialog(){
   remember();const rows=document.createElement('input'),cols=document.createElement('input');rows.type=cols.type='number';rows.min=cols.min='1';rows.max=cols.max='30';rows.value='3';cols.value='3';
   modal('table','插入表格',[text('p','行数 / 列数（1–30）'),rows,cols],[cancel,['插入',()=>{const r=Math.min(30,Math.max(1,Number(rows.value)||3)),c=Math.min(30,Math.max(1,Number(cols.value)||3));let h='<table><tbody>';for(let i=0;i<r;i++){h+='<tr>';for(let j=0;j<c;j++)h+=i===0?'<th>标题</th>':'<td><br></td>';h+='</tr>';}
    // A modal makes the editor inert; close it before restoring the caret and editing.
    dialog.close();insert(h+'</tbody></table><p><br></p>');
   },'primary']]);
 }
 const tools=[['type-bold','加粗','bold'],['type-italic','斜体','italic'],['type-underline','下划线','underline'],['type-strikethrough','删除线','strikeThrough'],['code-slash','代码',inlineCode],null,
  [null,'一级标题',()=>command('formatBlock','h1'),'H1'],[null,'二级标题',()=>command('formatBlock','h2'),'H2'],[null,'三级标题',()=>command('formatBlock','h3'),'H3'],null,
  ['list-ul','无序列表','insertUnorderedList'],['list-ol','有序列表','insertOrderedList'],['check2-square','待办事项',task],['table','插入表格',insertTableDialog],null,['unindent','减少缩进','outdent'],['indent','增加缩进','indent'],['arrow-counterclockwise','撤销','undo'],['arrow-clockwise','重做','redo'],['eraser','清除格式','removeFormat'],null,[null,'插入或编辑链接',linkDialog,'链接'],[null,'查找当前笔记',openFind,'查找'],[null,'快捷键说明',showShortcuts,'?']];
 const toolbar=document.getElementById('toolbar');
 for(const tool of tools){if(!tool){const s=document.createElement('span');s.className='separator';toolbar.append(s);continue;}const [icon,label,cmd,caption]=tool,b=document.createElement('button');b.title=label;b.setAttribute('aria-label',label);const shortcut=shortcuts.find(s=>s.id===cmd||s.label===label||(label==='代码'&&s.id==='inlineCode'));if(shortcut){b.title+=`（${shortcut.display}）`;const modifiers=(shortcut.alt?'Alt+':'')+(shortcut.shift?'Shift+':'');b.setAttribute('aria-keyshortcuts',`Meta+${modifiers}${shortcut.key.toUpperCase()} Control+${modifiers}${shortcut.key.toUpperCase()}`);}if(icon){const i=document.createElement('i');i.className=`bi bi-${icon}`;b.append(i);}else b.textContent=caption;b.onmousedown=e=>{e.preventDefault();remember();};b.onclick=()=>typeof cmd==='function'?cmd():command(cmd);toolbar.append(b);}
 document.getElementById('save').onclick=()=>action('save');
 document.getElementById('print').onclick=()=>{if(id)post({type:'print'});};
 document.getElementById('export').onclick=()=>{const n=active;if(n)setTimeout(()=>post({type:'export',id:n.id,title:n.title,html:n.node.innerHTML}),0);};
 onEditor('input',changed);
 onEditor('compositionstart',()=>{composing=true;});
 onEditor('compositionend',()=>{composing=false;changed();if(pendingLoad){const e=pendingLoad;pendingLoad=null;receive(e);}});
 onEditor('blur',()=>{remember();if(active&&pending(active))schedule(active,0);});
 document.addEventListener('selectionchange',remember);
 onEditor('change',e=>{if(e.target.matches('input[type=checkbox]')){e.target.toggleAttribute('checked',e.target.checked);changed();}});
 onEditor('click',e=>{if(e.target.tagName==='IMG'){e.preventDefault();return;}const a=e.target.closest('a');if(a){e.preventDefault();if(safeURL(a.href))post({type:'link',url:a.href});}});
 onEditor('keydown',e=>{
  if(e.isComposing)return;
  if(keyShortcut(e))return;
  syncImageSelection();
  if(selectedImage&&e.key==='Enter'){e.preventDefault();viewImage();return;}
  if(selectedImage&&['Backspace','Delete'].includes(e.key)){e.preventDefault();if(!imagePending)removeImage();return;}
  if(e.key==='Escape'&&selectedImage){e.preventDefault();getSelection().collapseToEnd();remember();clearImageSelection();return;}
  if(e.key==='Tab'){if(tableTab(e.shiftKey)){e.preventDefault();return;}const node=getSelection()?.anchorNode;const el=node?.nodeType===1?node:node?.parentElement;if(el?.closest('li')){e.preventDefault();command(e.shiftKey?'outdent':'indent');}return;}
  if(e.key!==' ')return;
  const s=getSelection();if(!s?.isCollapsed||!s.rangeCount||s.anchorNode.nodeType!==3)return;
  const node=s.anchorNode,offset=s.anchorOffset,prefix=node.textContent.slice(0,offset);
  const patterns={'#':['formatBlock','h1'],'##':['formatBlock','h2'],'###':['formatBlock','h3'],'-':['insertUnorderedList'],'*':['insertUnorderedList'],'1.':['insertOrderedList'],'>':['formatBlock','blockquote']};
  if(!patterns[prefix]&&!['[]','[ ]','- [ ]'].includes(prefix))return;
  e.preventDefault();const r=s.getRangeAt(0);r.setStart(node,0);r.setEnd(node,offset);s.removeAllRanges();s.addRange(r);document.execCommand('delete');selection=null;remember();if(patterns[prefix])command(...patterns[prefix]);else task();
 });
 function pasteTable(source){
  const node=selection?.startContainer,cell=(node?.nodeType===Node.ELEMENT_NODE?node:node?.parentElement)?.closest('td,th');
  if(!cell||!editor.contains(cell))return false;
  const table=cell.closest('table'),copy=table.cloneNode(true),startRow=cell.parentElement.rowIndex,startCol=cell.cellIndex;
  const incoming=[...source.rows].map(row=>[...row.cells].map(cell=>{
   const copy=cell.cloneNode(true);for(const nested of copy.querySelectorAll('table'))nested.replaceWith(document.createTextNode(nested.textContent));return copy.innerHTML;
  }));
  if(!incoming.length)return true;
  // Preserve merged layouts rather than distributing values into ambiguous cell positions.
  if([...table.rows].some(row=>[...row.cells].some(cell=>cell.colSpan!==1||cell.rowSpan!==1))){
   command('insertText',incoming.map(row=>row.map(html=>{const node=document.createElement('div');node.innerHTML=html;for(const br of node.querySelectorAll('br'))br.replaceWith('\n');return node.textContent;}).join('\t')).join('\n'));return true;
  }
  let width=0;for(const row of copy.rows)width=Math.max(width,row.cells.length);for(const row of incoming)width=Math.max(width,startCol+row.length);
  const height=Math.max(copy.rows.length,startRow+incoming.length);
  if(width>2048||height>200000||width*height>2000000){receive({type:'error',message:'表格最多 20 万行、2048 列、200 万个单元格'});return true;}
  while(copy.rows.length<height)copy.insertRow(-1);
  for(const row of copy.rows)while(row.cells.length<width){const cell=document.createElement(row.parentElement.tagName==='THEAD'?'th':'td');cell.innerHTML='<br>';row.append(cell);}
  for(const [y,row] of incoming.entries())for(const [x,html] of row.entries())copy.rows[startRow+y].cells[startCol+x].innerHTML=html||'<br>';
  // Replace the enclosing table as one native edit, preserving undo/redo.
  const parent=table.parentNode,index=[...parent.childNodes].indexOf(table),range=document.createRange();range.selectNode(table);selection=range;
  insert(copy.outerHTML);
  const inserted=parent.childNodes[index];if(inserted?.tagName==='TABLE'){const target=inserted.rows[startRow+incoming.length-1]?.cells[startCol+(incoming.at(-1)?.length||1)-1];if(target){const range=document.createRange();range.selectNodeContents(target);range.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(range);remember();}}
  return true;
 }
 function pasteLink(url){
  const token=++linkToken,a=text('a',url);a.href=url;a.dataset.pastedLink=token;
  insert(a.outerHTML);
  const link=editor.querySelector(`[data-pasted-link="${token}"]`);if(!link)return;
  link.removeAttribute('data-pasted-link');
  // Bound both outstanding requests and titles waiting for an inactive note.
  if(pastedLinks.size>=16)pastedLinks.delete(pastedLinks.keys().next().value);
  pastedLinks.set(token,{note:active,link,url});
  post({type:'link_metadata',token,url});
 }
 function applyLinkTitles(){
  if(composing||dialog.open||window.cnoteTools?.workspace||!editor.contains(document.activeElement))return;
  for(const [token,request]of pastedLinks){
   const {note,link,url,title}=request;
   if(note!==active||title===undefined)continue;
   pastedLinks.delete(token);
   // Undo, deletion, remote replacement or manual edits invalidate the request.
   if(!title||!editor.contains(link)||link.getAttribute('href')!==url||link.textContent!==url)continue;
   const s=getSelection();if(!s?.rangeCount)continue;
   const saved=s.getRangeAt(0).cloneRange();
   if(!saved.collapsed&&saved.intersectsNode(link))continue;
   const atLink=link.contains(saved.startContainer);
   const range=document.createRange();range.selectNode(link);s.removeAllRanges();s.addRange(range);
   // A native edit keeps title replacement undoable, unlike a DOM text mutation.
   const replacement=text('a',title);replacement.href=url;replacement.dataset.pastedLink=token;
   document.execCommand('insertHTML',false,replacement.outerHTML);
   const inserted=editor.querySelector(`[data-pasted-link="${token}"]`);inserted?.removeAttribute('data-pasted-link');
   if(atLink&&inserted){saved.setStartAfter(inserted);saved.collapse(true);}
   s.removeAllRanges();s.addRange(saved);remember();changed();
  }
 }
 onEditor('focusin',()=>{if(pastedLinks.size)setTimeout(applyLinkTitles,0);});
 onEditor('compositionend',()=>{if(pastedLinks.size)setTimeout(applyLinkTitles,0);});
 onEditor('paste',e=>{
  const clipboard=e.clipboardData;if(!clipboard)return;e.preventDefault();remember();
  if(plainPaste){plainPaste=false;clearTimeout(plainPasteTimer);command('insertText',clipboard.getData('text/plain'));return;}
  const image=[...clipboard.items].find(i=>i.type.startsWith('image/'));
  if(image){const file=image.getAsFile();if(!file||file.size>8*1024*1024){receive({type:'error',message:'图片最大支持 8 MB，请缩小后重试。'});return;}const target=id;const reader=new FileReader();reader.onload=()=>{if(target!==id)return;const img=document.createElement('img');img.src=reader.result;img.alt='粘贴的图片';insert(img.outerHTML);};reader.readAsDataURL(file);return;}
  const html=clipboard.getData('text/html'),plain=clipboard.getData('text/plain');
  // Match the web notebook: a lone HTTP(S) URL takes precedence over clipboard HTML.
  const url=plain.trim();
  if(/^https?:\/\/\S+$/i.test(url)&&safeURL(url)){pasteLink(url);return;}
  // Real HTML tables preserve formatting; terminal apps often supply only a <pre> wrapper.
  const safe=html?sanitize(html):'',template=document.createElement('template');if(safe)template.innerHTML=safe;
  const source=template.content.querySelector('table'),rows=source?null:window.cnoteTableText.detect(plain);
  if(source&&pasteTable(source))return;
  if(rows){const table=document.createElement('table'),tbody=document.createElement('tbody');
   for(const [i,row] of rows.entries()){const tr=document.createElement('tr');for(const value of row){const cell=document.createElement(i?'td':'th');const lines=value.split('\n');for(const [j,line] of lines.entries()){if(j)cell.append(document.createElement('br'));cell.append(document.createTextNode(line));}if(!value)cell.append(document.createElement('br'));tr.append(cell);}tbody.append(tr);}table.append(tbody);if(!pasteTable(table))insert(table.outerHTML+'<p><br></p>');
  }else if(html)insert(safe);else if(safeURL(plain.trim())){const a=text('a',plain.trim());a.href=plain.trim();insert(a.outerHTML);}else command('insertText',plain);
 });
 const menu=document.getElementById('context');
 const tableActions=[['在上方插入行','row-before'],['在下方插入行','row-after'],['在左侧插入列','col-before'],['在右侧插入列','col-after'],['删除行','delete-row'],['删除列','delete-col'],['删除表格','delete-table']];
 function tableAction(op){const cell=contextCell;if(!cell)return;const row=cell.parentElement,table=cell.closest('table'),index=cell.cellIndex;
  if(op==='delete-table'){if(!table||!editor.contains(table))return;const range=document.createRange();range.selectNode(table);selection=range;command('delete');contextCell=null;menu.hidden=true;return;}
  if(op.startsWith('row')){const next=document.createElement('tr');for(let i=0;i<row.cells.length;i++){const td=document.createElement('td');td.innerHTML='<br>';next.append(td);}if(op==='row-before')row.before(next);else row.after(next);}
  else if(op==='delete-row')row.remove();else for(const r of [...table.rows]){if(op==='delete-col')r.cells[index]?.remove();else{const td=document.createElement(r.parentElement.tagName==='THEAD'?'th':'td');td.innerHTML='<br>';r.insertBefore(td,r.cells[index+(op==='col-after'?1:0)]||null);}}
  if(!table.rows.length||![...table.rows].some(r=>r.cells.length))table.remove();menu.hidden=true;changed();
 }
 onEditor('contextmenu',e=>{
  const image=e.target.closest('img'),cell=e.target.closest('td,th');if(!image&&!cell)return;e.preventDefault();menu.replaceChildren();
  const entries=image?[['放大查看',()=>viewImage(image)],['复制图片',()=>imageClipboard()],['剪切图片',()=>imageClipboard(true)],['删除图片',()=>removeImage(image)]]:tableActions.map(([label,op])=>[label,()=>tableAction(op)]);
  if(image)selectImage(image);else contextCell=cell;
  for(const [label,action]of entries){const b=text('button',label);b.type='button';b.onmousedown=event=>event.preventDefault();b.onclick=()=>{menu.hidden=true;action();};menu.append(b);}
  menu.hidden=false;menu.style.left=Math.max(0,Math.min(e.clientX,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(0,Math.min(e.clientY,innerHeight-menu.offsetHeight-8))+'px';
 });
 document.addEventListener('mousedown',e=>{if(!menu.contains(e.target))menu.hidden=true;});
 document.addEventListener('keydown',e=>{if(!e.defaultPrevented&&(e.metaKey||e.ctrlKey)&&!e.isComposing&&!e.altKey&&!e.shiftKey){if(e.key.toLowerCase()==='s'){e.preventDefault();if(window.cnoteTools?.workspace)window.cnoteTools.flush();else action('save');}if(e.key.toLowerCase()==='n'){e.preventDefault();action('new');}if(e.key.toLowerCase()==='q'){e.preventDefault();action('close');}if(e.key==='\\'){e.preventDefault();post({type:'sidebar'});}}});
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
   case 'link_metadata_result':{
    const request=pastedLinks.get(e.token);if(!request)break;
    if(typeof e.title!=='string'||!e.title.trim()){pastedLinks.delete(e.token);break;}
    request.title=e.title.trim().slice(0,300);applyLinkTitles();break;
   }
   case 'image_clipboard_result':{
    const request=imagePending;if(!request||request.token!==e.token)break;
    imagePending=null;positionImageActions();
    if(!e.ok){imageStatus(`图片复制失败：${e.message||'系统剪贴板不可用'}。原图已保留。`,true);break;}
    if(request.cut){
     if(id!==request.id||!editor.contains(request.image)||request.image.getAttribute('src')!==request.src){imageStatus('图片已复制；笔记或图片已变化，未移除原图。');break;}
     imageStatus(removeImage(request.image)?'图片已剪切 · ⌘Z 可撤销':'图片已复制，未能移除原图，请重试剪切。');
    }else imageStatus('图片已复制，可粘贴到笔记或其他应用。');break;
   }
   case 'theme':window.cnoteTheme.set(e.theme);break;
   case 'cache_reset':resetCache(e.generation,e.account);break;
   case 'preload':preload(e);break;
   case 'tool_state':case 'tool_saved':case 'tool_save_failed':window.cnoteTools?.receive(e);break;
   case 'load':{
    if(e.intent!==undefined&&e.intent<intent)return;
    if(composing){pendingLoad=e;return;}
    if(!e.id){
     clearImageSelection();
     if(active){active.pane.classList.remove('active');active.pane.setAttribute('aria-hidden','true');}active=null;id='';selection=null;editor.removeAttribute('id');
     document.getElementById('document').hidden=true;document.getElementById('empty').style.display='flex';break;
    }
    let n=notes.get(e.id);
    if(n&&pending(n)){activate(n);return;}
    if(!n)n=record(e.id,e.title,e.html);
    else if(!n.loaded||n.source!==e.html){
     clearImageSelection();n.node.innerHTML=sanitize(e.html);n.source=e.html;n.bytes=e.html.length;n.loaded=true;n.node.contentEditable='true';n.selection=null;
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
    if(pendingConflictResult)pendingConflictResult.receive({ok:false,message:'本地草稿保存失败：'+e.message});
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
    if(e.kind==='conflict_result'){if(pendingConflictResult?.id===d.id)pendingConflictResult.receive(d);return;}
    if(e.kind==='conflict')conflictDialog(d);
    if(e.kind==='conflict_view')showConflict(d);
    break;
   }
  }
 }
 window.cnote={action,receive,flush,sanitize,formatShortcut,pastePlain,shortcuts,focusEditor:restore};post({type:'ready'});
})();
