import init, { Notebook } from './pkg/cnote_web.js';
import { PublicClientApplication } from '@azure/msal-browser';
import { diffArrays } from 'diff';

let config;
const status = message => { document.getElementById('status').textContent = message; };
const emit = event => window.cnote.receive(event);
const editing = new Set();
let notebook, db, auth, authAccount, dirty = false, syncing = false, syncTimer, released;
let queue = Promise.resolve();
const snapshot = () => JSON.parse(notebook.snapshot());
const view = () => JSON.parse(notebook.view());
const note = id => snapshot().notes.find(n => n.id === id && n.account === snapshot().account);
const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
function transact(mode, operation) {
 return new Promise((resolve, reject) => {
  const transaction = db.transaction('state', mode), store = transaction.objectStore('state');
  const request = operation(store); let result;
  request.onsuccess = () => { result = request.result; };
  transaction.oncomplete = () => resolve(result);
  transaction.onerror = transaction.onabort = () => reject(Error('浏览器存储失败，请导出笔记后重试'));
 });
}
async function mutate(command) {
 const previous = notebook.snapshot();
 try {
  const result = JSON.parse(notebook.execute(JSON.stringify({ now: Date.now(), ...command })));
  await transact('readwrite', store => store.put(notebook.snapshot(), 'notebook'));
  render(); return result;
 } catch (error) { notebook.free(); notebook = new Notebook(previous); throw error; }
}
function render() {
 const state = view(), list = document.getElementById('note-list');list.replaceChildren();
 for (const n of state.notes.sort((a,b) => b.modified-a.modified)) {
  const row = document.createElement('div'), open = document.createElement('button'), remove = document.createElement('button');
  row.className = 'note-row';open.textContent = (n.conflict?'⚠ ':n.dirty?'• ':'') + n.title;open.className = n.id===state.selected?'active':'';
  open.onclick = () => {if(mobileLayout.matches)setDrawer(false);window.cnote.action('open',{id:n.id});};
  remove.textContent = '×';remove.title = `删除 ${n.title}`;remove.onclick = () => window.cnote.action('delete',{id:n.id,title:n.title});
  row.append(open,remove);list.append(row);
 }
 document.getElementById('login').textContent = authAccount?'退出 OneDrive':'登录 OneDrive';
 document.getElementById('account').textContent = authAccount?.name || (state.account?'已离线保留上次账号的笔记':'本机笔记');
}
async function open(id,intent) {
 const result = await mutate({type:'open',id});emit({...result,intent});
 if(mobileLayout.matches)setDrawer(false);
 if(note(id)?.conflict)emit({type:'dialog',kind:'conflict',data:{id}});
}
function laterSync() { clearTimeout(syncTimer);syncTimer=setTimeout(()=>sync().catch(()=>status('OneDrive 同步失败，本地草稿已保留')),2000); }
async function handle(m) {
 switch(m.type) {
  case 'dirty':dirty=true;break;
  case 'clean':dirty=false;break;
  case 'editing':editing.add(m.id);break;
  case 'settled':editing.delete(m.id);break;
  case 'navigation':break;
  case 'ready': {
   const state=view();emit({type:'cache_reset',generation:1,account:state.account});
   const id=state.notes.some(n=>n.id===state.selected)?state.selected:state.notes[0]?.id;
   if(id)await open(id);else emit({type:'load',id:''});break;
  }
  case 'new': {
   const id=crypto.randomUUID(), title=String(m.title||'未命名笔记').replace(/[\\/:*?"<>|]/g,'-');
   const heading=document.createElement('h1');heading.textContent=title;
   await mutate({type:'new',id,title,html:heading.outerHTML+'<p><br></p>'});await open(id);window.cnote.focusEditor();laterSync();break;
  }
  case 'open':await open(m.id,m.intent);break;
  case 'change':
   try { await mutate(m);emit({type:'saved',id:m.id,seq:m.seq});laterSync(); }
   catch { emit({type:'save_failed',id:m.id,seq:m.seq,message:'浏览器未能持久化正文'}); }break;
  case 'delete':await mutate(m);emit({type:'load',id:''});laterSync();break;
  case 'save':case 'sync':case 'refresh':case 'refresh_workspace':laterSync();break;
  case 'conflict_view':emit(JSON.parse(notebook.execute(JSON.stringify(m))));break;
  case 'resolve':
   try { const result=await mutate(m);emit(result);emit(JSON.parse(notebook.execute(JSON.stringify({type:'open',id:m.id}))));laterSync(); }
   catch { emit({type:'dialog',kind:'conflict_result',data:{id:m.id,ok:false,message:'草稿或云端版本已变化，或本地保存失败，请重新对比'}}); }break;
  case 'login':await login();break;
  case 'logout':await logout();break;
  case 'sidebar':toggleSidebar();break;
  case 'link': {
   try { const url=new URL(m.url);if(['http:','https:','mailto:'].includes(url.protocol))window.open(url.href,'_blank','noopener,noreferrer'); } catch {} break;
  }
  case 'link_metadata':void metadata(m);break;
  case 'image_clipboard':
   try {
    const response=await fetch(m.src), blob=await response.blob();
    const bitmap=await createImageBitmap(blob), canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);emit({type:'image_clipboard_result',token:m.token,ok:true});
   } catch { emit({type:'image_clipboard_result',token:m.token,ok:false,message:'浏览器未允许复制图片，请使用图片右键保存'}); }break;
  case 'print':window.print();break;
  case 'export': {
   const url=URL.createObjectURL(new Blob(['<!doctype html><meta charset="utf-8">'+window.cnote.sanitize(m.html)],{type:'text/html;charset=utf-8'}));
   const a=document.createElement('a');a.href=url;a.download=String(m.title||'笔记').replace(/[\\/:*?"<>|]/g,'-')+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;
  }
  case 'close':window.cnote.flush();status('请使用浏览器关闭标签页；笔记已自动保存');break;
 }
}
async function metadata(m) {
 let title='';
 try {
  const url=new URL(m.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();
  const target=config.metadataEndpoint?new URL(config.metadataEndpoint,location.href):url;
  if(config.metadataEndpoint){if(target.origin!==location.origin)throw Error();target.searchParams.set('url',url.href);}
  const response=await fetch(target,{credentials:'omit',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error();
  if(config.metadataEndpoint)title=String((await response.json()).title||'');
  else {
   if(!response.headers.get('content-type')?.toLowerCase().includes('text/html'))throw Error();
   const reader=response.body.getReader(),chunks=[];let size=0;
   try { while(size<1024*1024){const {done,value}=await reader.read();if(done)break;chunks.push(value.subarray(0,1024*1024-size));size+=value.length;} } finally { await reader.cancel(); }
   const bytes=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   title=new DOMParser().parseFromString(new TextDecoder().decode(bytes),'text/html').title;
  }
 } catch { /* CORS and network failures retain the URL. No third-party proxy. */ }
 emit({type:'link_metadata_result',token:m.token,title});
}
const scopes=['Files.ReadWrite','User.Read'];
async function login() {
 const result=await auth.loginPopup({scopes,prompt:'select_account'});
 authAccount=result.account;auth.setActiveAccount(authAccount);
 await mutate({type:'account',account:authAccount.homeAccountId});
 emit({type:'cache_reset',generation:Date.now(),account:authAccount.homeAccountId});
 emit({type:'load',id:''});const first=view().notes[0];if(first)await open(first.id);render();laterSync();
}
async function logout() {
 // Remove this app's cached login without navigating or losing local drafts.
 await auth.clearCache({account:authAccount});authAccount=null;
 await mutate({type:'account',account:''});emit({type:'cache_reset',generation:Date.now(),account:''});emit({type:'load',id:''});render();status('已退出，本机保留原账号笔记');
}
async function graph(path,options={}) {
 if(!authAccount)throw Error('需要登录');
 const url=new URL(path.startsWith('https:')?path:'https://graph.microsoft.com/v1.0'+path);
 if(url.origin!=='https://graph.microsoft.com'||!url.pathname.startsWith('/v1.0/'))throw Error('拒绝不可信分页地址');
 const {accessToken}=await auth.acquireTokenSilent({account:authAccount,scopes});
 return fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(25000)});
}
async function checked(response) { if(!response.ok)throw Error(`OneDrive 请求失败 (${response.status})`);return response; }
async function download(id) {
 const path='/me/drive/items/'+encodeURIComponent(id);
 const before=await (await checked(await graph(path+'?$select=id,name,eTag'))).json();
 const html=await (await checked(await graph(path+'/content'))).text();
 const after=await (await checked(await graph(path+'?$select=id,name,eTag'))).json();
 if(before.eTag!==after.eTag)throw Error('云端版本变化，请重试');
 if(html.length>20*1024*1024)throw Error('笔记超过 20 MB');
 return {html,etag:after.eTag,title:after.name};
}
async function sync() {
 if(syncing||!authAccount)return;syncing=true;const account=authAccount.homeAccountId;
 try {
  status('正在同步 OneDrive…');let path='/me/drive/root:/Notes:/children?$select=id,name,eTag,file&$top=200',items=[];
  while(path){
   let response=await graph(path);
   if(response.status===404){await checked(await graph('/me/drive/root/children',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Notes',folder:{},'@microsoft.graph.conflictBehavior':'fail'})}));response=await graph(path);}
   const page=await (await checked(response)).json();items.push(...(page.value||[]).filter(n=>n.file&&n.name.endsWith('.html')));path=page['@odata.nextLink'];
  }
  const remote=new Map(items.map(n=>[n.id,n]));
  for(const item of items){
   if(snapshot().account!==account)return;
   const local=snapshot().notes.find(n=>n.account===account&&n.remote_id===item.id);
   if(local?.etag===item.eTag||editing.has(local?.id))continue;
   const data=await download(item.id);
   await enqueue(async()=>{
    if(snapshot().account!==account||editing.has(local?.id))return;
    if(local){
     await mutate({type:'remote',id:local.id,...data});
     if(note(local.id).conflict){if(view().selected===local.id)emit({type:'dialog',kind:'conflict',data:{id:local.id}});}
     else if(view().selected===local.id)emit(JSON.parse(notebook.execute(JSON.stringify({type:'open',id:local.id}))));
    }else await mutate({type:'import',id:crypto.randomUUID(),remote_id:item.id,title:item.name.replace(/--[a-f0-9]{8}\.html$/i,'').replace(/\.html$/i,''),...data});
   });
  }
  for(const cached of snapshot().notes.filter(n=>n.account===account&&n.remote_id&&!remote.has(n.remote_id)&&!n.dirty)){
   await enqueue(async()=>{
    if(snapshot().account!==account||editing.has(cached.id))return;
    const selected=view().selected;
    await mutate({type:'remote_removed',id:cached.id,revision:cached.revision});
    if(selected===cached.id&&!note(cached.id))emit({type:'load',id:''});
   });
  }
  for(const sent of snapshot().notes.filter(n=>n.account===account&&n.dirty&&!n.conflict)){
   if(snapshot().account!==account)return;if(editing.has(sent.id))continue;
   if(sent.deleted){
    if(sent.remote_id){
     if(!sent.etag)throw Error('缺少删除版本');const response=await graph('/me/drive/items/'+encodeURIComponent(sent.remote_id),{method:'DELETE',headers:{'If-Match':sent.etag}});
     if(response.status===412){
      const data=await download(sent.remote_id);await enqueue(async()=>{if(snapshot().account!==account)return;await mutate({type:'remote',id:sent.id,...data});if(view().selected===sent.id)emit({type:'dialog',kind:'conflict',data:{id:sent.id}});});continue;
     }
     if(response.status!==404)await checked(response);
    }
    await enqueue(()=>snapshot().account===account?mutate({type:'removed',id:sent.id,revision:sent.revision}):null);continue;
   }
   if(sent.remote_id&&!remote.has(sent.remote_id)){status('云端笔记已删除，本机草稿保留，请导出或新建笔记');continue;}
   const filename=sent.title.replace(/[\\/:*?"<>|]/g,'-')+'--'+sent.id.slice(0,8)+'.html';
   const base='/me/drive/root:/Notes/'+encodeURIComponent(filename);
   // Recover a creation whose response was lost; never overwrite a same-name file.
   if(!sent.remote_id){
    const existing=await graph(base);
    if(existing.ok){
     const item=await existing.json(),data=await download(item.id);
     await enqueue(async()=>{if(snapshot().account!==account)return;await mutate({type:'uploaded',id:sent.id,revision:data.html===sent.html?sent.revision:-1,remote_id:item.id,etag:data.etag,html:sent.html});if(data.html!==sent.html)await mutate({type:'remote',id:sent.id,...data});});continue;
    }if(existing.status!==404)await checked(existing);
   }
   const path=sent.remote_id?'/me/drive/items/'+encodeURIComponent(sent.remote_id)+'/content':base+':/content?@microsoft.graph.conflictBehavior=fail';
   if(sent.remote_id&&!sent.etag)throw Error('缺少上传版本');
   const response=await graph(path,{method:'PUT',headers:{'Content-Type':'text/html; charset=utf-8',...(sent.remote_id?{'If-Match':sent.etag}:{})},body:sent.html});
   if(response.status===412||response.status===409){
    if(sent.remote_id){const data=await download(sent.remote_id);await enqueue(async()=>{if(snapshot().account!==account)return;await mutate({type:'remote',id:sent.id,...data});if(view().selected===sent.id)emit({type:'dialog',kind:'conflict',data:{id:sent.id}});});}continue;
   }
   const item=await (await checked(response)).json();
   await enqueue(()=>snapshot().account===account?mutate({type:'uploaded',id:sent.id,revision:sent.revision,html:sent.html,remote_id:item.id,etag:item.eTag}):null);
  }
  const pending=snapshot().notes.filter(n=>n.account===account&&(n.dirty||n.conflict)).length;
  status(pending?`本机已保存 · ${pending} 篇笔记待同步或处理冲突`:'本机已保存 · OneDrive 同步检查完成');
 } finally { syncing=false; }
}
// Notes-only compatibility surface: there is no tool draft to flush.
window.cnoteTools={workspace:0,flush(){},compareNote:async({left,right})=>{
 const tokens=html=>html.split(/(?<=<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>|<br>|<hr>|\n)/i);
 const parts=diffArrays(tokens(left),tokens(right),{timeout:1500,maxEditLength:10000});
 if(!parts)throw Error('差异过多，请选择整篇版本');
 return parts.map(part=>({kind:part.added?'added':part.removed?'removed':'same',html:part.value.join('')}));
}};
window.addEventListener('beforeunload',event=>{window.cnote?.flush();if(dirty||editing.size){event.preventDefault();event.returnValue='';}});
window.addEventListener('online',laterSync);
setInterval(()=>{if(authAccount&&!document.hidden)laterSync();},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)laterSync();});
const mobileLayout=matchMedia('(max-width:700px), (max-width:1000px) and (hover:none) and (pointer:coarse)'), sidebar=document.getElementById('web-sidebar'), drawerToggle=document.getElementById('mobile-note-list'), drawerShade=document.getElementById('sidebar-shade');
function updateSidebar(){
 const mobile=mobileLayout.matches, opened=mobile&&document.body.classList.contains('mobile-sidebar-open');
 sidebar.inert=mobile?!opened:document.body.classList.contains('sidebar-hidden');
 sidebar.setAttribute('aria-hidden',String(sidebar.inert));
 if(opened){sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');}else{sidebar.removeAttribute('role');sidebar.removeAttribute('aria-modal');}
 drawerToggle.setAttribute('aria-expanded',String(opened));drawerShade.hidden=!opened;
 for(const element of document.querySelectorAll('body>header,body>main,body>footer'))element.inert=opened;
}
function setDrawer(opened){
 const wasOpen=document.body.classList.contains('mobile-sidebar-open');
 document.body.classList.toggle('mobile-sidebar-open',mobileLayout.matches&&opened);
 document.getElementById('mobile-more').open=false;updateSidebar();
 if(mobileLayout.matches&&opened)document.getElementById('close-sidebar').focus();
 else if(mobileLayout.matches&&wasOpen)drawerToggle.focus();
}
function toggleSidebar(){
 if(mobileLayout.matches)setDrawer(!document.body.classList.contains('mobile-sidebar-open'));
 else{document.body.classList.toggle('sidebar-hidden');updateSidebar();}
}
function viewportHeight(){
 if(mobileLayout.matches&&window.visualViewport)document.body.style.setProperty('--web-viewport-height',`${window.visualViewport.height}px`);
 else document.body.style.removeProperty('--web-viewport-height');
}
mobileLayout.addEventListener('change',()=>{setDrawer(false);viewportHeight();});
window.visualViewport?.addEventListener('resize',viewportHeight);window.addEventListener('resize',viewportHeight);
updateSidebar();viewportHeight();
drawerToggle.onclick=toggleSidebar;
for(const button of [document.getElementById('close-sidebar'),drawerShade])button.onclick=()=>setDrawer(false);
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'){if(document.body.classList.contains('mobile-sidebar-open')){event.preventDefault();setDrawer(false);}document.getElementById('mobile-more').open=false;}
 if(event.key==='Tab'&&mobileLayout.matches&&document.body.classList.contains('mobile-sidebar-open')){
  const controls=[...sidebar.querySelectorAll('button,select,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
 }
});
const more=document.getElementById('mobile-more');
document.addEventListener('click',event=>{if(!more.contains(event.target))more.open=false;});
for(const action of ['export','print'])document.getElementById('mobile-'+action).onclick=()=>{more.open=false;document.getElementById(action).click();};
document.getElementById('new-note').onclick=()=>{if(mobileLayout.matches)setDrawer(false);window.cnote.action('new');};
document.getElementById('refresh').onclick=()=>window.cnote.action('save');
document.getElementById('toggle-sidebar').onclick=toggleSidebar;
document.getElementById('login').onclick=()=>{if(mobileLayout.matches)setDrawer(false);window.cnote.action(authAccount?'logout':'login');};
document.getElementById('theme').onchange=event=>{window.cnoteTheme.set(event.target.value);localStorage.setItem('cnote-web-theme',event.target.value);};
try {
 config=await fetch('./config.json').then(r=>{if(!r.ok)throw Error('无法读取配置');return r.json();});
 await init();
 if(!navigator.locks)throw Error('此浏览器不支持 Web Locks，请使用新版浏览器');
 await new Promise((resolve,reject)=>{
  navigator.locks.request('cnote-web-writer',{ifAvailable:true},lock=>{
   if(!lock){reject(Error('笔记已在另一个标签页打开，请先关闭该页面再刷新'));return;}
   resolve();return new Promise(done=>{released=done;});
  }).catch(reject);
 });
 window.addEventListener('pagehide',()=>released?.(),{once:true});
 window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
 db=await new Promise((resolve,reject)=>{const request=indexedDB.open('cnote-web',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('无法打开浏览器笔记数据库'));});
 notebook=new Notebook((await transact('readonly',store=>store.get('notebook')))||'');
 auth=new PublicClientApplication({auth:{clientId:config.clientId,authority:'https://login.microsoftonline.com/consumers',redirectUri:new URL(config.redirectUri||'./auth.html',location.href).href},cache:{cacheLocation:'sessionStorage'}});
 await auth.initialize();
 authAccount=auth.getAllAccounts().find(a=>a.homeAccountId===snapshot().account)||null;if(authAccount)auth.setActiveAccount(authAccount);
 const preference=localStorage.getItem('cnote-web-theme')||'system';window.cnoteTheme.set(preference);document.getElementById('theme').value=preference;
 window.ipc.postMessage=message=>{const m=JSON.parse(message);enqueue(()=>handle(m)).catch(()=>status('操作未完成，本地草稿保留；请重试或导出笔记'));};
 render();for(const message of window.cnoteWebQueue.splice(0))window.ipc.postMessage(message);
 document.body.dataset.ready='true';if(authAccount)laterSync();
} catch(error) {
 status(error.message||'笔记启动失败');for(const editor of document.querySelectorAll('[contenteditable]'))editor.contentEditable='false';
 for(const button of document.querySelectorAll('button,select'))button.disabled=true;
 document.body.dataset.failed='true';
}
