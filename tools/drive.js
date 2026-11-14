'use strict';
(() => {
 const root=document.getElementById('drive-tool');if(!root)return;
 root.innerHTML=`<div class="drive-heading"><div><h1>OneDrive</h1><p id="drive-account">你的云端文件</p></div><button id="drive-login">登录 OneDrive</button></div>
 <div class="drive-toolbar"><button id="drive-up" title="上一级 ⌘↑">↑</button><button id="drive-refresh" title="刷新 ⌘R">刷新</button><button id="drive-mkdir">新建文件夹</button><button id="drive-new">新建文本</button><button id="drive-upload">上传文件</button><input id="drive-files" type="file" multiple hidden><span class="spacer"></span><form id="drive-search-form"><input id="drive-search" type="search" placeholder="搜索此目录及子目录…" aria-label="搜索 OneDrive"><button>搜索</button></form></div>
 <nav id="drive-crumbs" aria-label="文件路径"></nav>
 <div class="drive-toolbar drive-selection"><span id="drive-selection">未选择</span><button id="drive-download">下载 / 复制 ⌘C</button><button id="drive-open">打开本地副本</button><button id="drive-edit">查看 / 编辑文本</button><button id="drive-rename">重命名 ↩</button><button id="drive-move">移动</button><button id="drive-delete">删除 ⌘⌫</button><span class="spacer"></span><select id="drive-sort" aria-label="文件排序"><option value="name">名称</option><option value="date">修改时间</option><option value="size">大小</option><option value="type">类型</option></select><button id="drive-order" aria-label="切换升降序">↑ 升序</button></div>
 <div id="drive-list" role="listbox" tabindex="0" aria-label="文件列表" aria-multiselectable="true"></div><p id="drive-status" role="status"></p>
 <dialog id="drive-dialog"><form method="dialog"><h2 id="drive-dialog-title"></h2><p id="drive-dialog-description"></p><input id="drive-dialog-name" aria-label="名称或目标路径"><textarea id="drive-dialog-text" aria-label="文件文本" spellcheck="false"></textarea><div class="drive-dialog-actions"><button value="cancel">取消</button><button value="ok" class="primary" id="drive-dialog-ok">确定</button></div></form></dialog>`;
 const $=id=>document.getElementById('drive-'+id),pending=new Map();
 let serial=0,version=0,items=[],folder=null,crumbs=[{id:'',name:'OneDrive'}],selected=new Set(),visible=[],anchor=-1,ascending=true,busy=false,loaded=false,authenticated=false,accountName='';
 function status(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
 function request(op,data={}){const request=++serial;return new Promise((resolve,reject)=>{pending.set(request,{resolve,reject});window.ipc.postMessage(JSON.stringify({type:'drive',request,op,...data}));});}
 function receive(event){const job=pending.get(event.request);if(!job)return;pending.delete(event.request);event.error?job.reject(Error(event.error)):job.resolve(event.data);}
 function account(value,name){const changed=authenticated!==value||accountName!==name;authenticated=value;accountName=name;$('account').textContent=value?name:'登录后管理你的 OneDrive 文件';$('login').hidden=value;if(changed){if($('dialog').open)$('dialog').close('cancel');for(const job of pending.values())job.reject(Error("OneDrive 账号已变化，请重试"));pending.clear();version++;items=[];folder=null;selected.clear();loaded=false;crumbs=[{id:'',name:'OneDrive'}];render();if(value&&window.cnoteTools?.workspace===5)refresh();}}
 function parent(){return folder?.id||crumbs.at(-1).id;}
 function picked(){return items.filter(item=>selected.has(item.id));}
 function size(value){let n=Number(value)||0;for(const u of ['B','KB','MB','GB','TB']){if(n<1024||u==='TB')return (u==='B'?n:n.toFixed(1))+' '+u;n/=1024;}}
 function type(item){return item.folder?'文件夹':item.name.includes('.')?item.name.split('.').at(-1).toUpperCase():'文件';}
 function render(){
  const key=$('sort').value;
  visible=[...items].sort((a,b)=>{if(!!a.folder!==!!b.folder)return a.folder?-1:1;let n=key==='size'?(a.size||0)-(b.size||0):key==='date'?String(a.lastModifiedDateTime).localeCompare(String(b.lastModifiedDateTime)):key==='type'?type(a).localeCompare(type(b)):a.name.localeCompare(b.name,'zh-CN',{numeric:true});return (ascending?1:-1)*n||a.name.localeCompare(b.name);});
  const list=$('list');list.replaceChildren();
  const heading=document.createElement('div');heading.className='drive-row drive-columns';for(const text of ['名称','修改时间','类型','大小']){const cell=document.createElement('span');cell.textContent=text;heading.append(cell);}list.append(heading);
  for(const [index,item] of visible.entries()){
   const row=document.createElement('div');row.className='drive-row';row.setAttribute('role','option');row.setAttribute('aria-selected',String(selected.has(item.id)));row.dataset.id=item.id;
   for(const text of [(item.folder?'📁  ':'📄  ')+item.name,item.lastModifiedDateTime?new Date(item.lastModifiedDateTime).toLocaleString('zh-CN'):'—',type(item),item.folder?'—':size(item.size)]){const cell=document.createElement('span');cell.textContent=text;row.append(cell);}
   row.onclick=event=>{if(busy)return;if(event.shiftKey&&anchor>=0){if(!event.metaKey)selected.clear();for(let i=Math.min(anchor,index);i<=Math.max(anchor,index);i++)selected.add(visible[i].id);}else if(event.metaKey){selected.has(item.id)?selected.delete(item.id):selected.add(item.id);anchor=index;}else{selected=new Set([item.id]);anchor=index;}render();list.focus();};
   row.ondblclick=()=>{if(busy)return;selected=new Set([item.id]);item.folder?enter(item):download(true);};list.append(row);
  }
  if(!items.length){const empty=document.createElement('p');empty.className='drive-empty';empty.textContent=authenticated?'此处没有文件':'请先登录 OneDrive';list.append(empty);}
  $('selection').textContent=`${items.length} 项 · 已选 ${selected.size} 项`;
  for(const id of ['download','delete'])$(id).disabled=busy||!selected.size;
  for(const id of ['open','edit','rename','move'])$(id).disabled=busy||selected.size!==1||(id==='edit'&&!!picked()[0]?.folder);
  for(const id of ['mkdir','new','upload','refresh','search'])$(id).disabled=busy||!authenticated;
  $('up').disabled=busy||crumbs.length<2;
  $('crumbs').replaceChildren();for(const [i,crumb]of crumbs.entries()){const button=document.createElement('button');button.textContent=crumb.name;button.disabled=busy;button.onclick=()=>navigate(crumbs.slice(0,i+1));$('crumbs').append(button);}
 }
 async function refresh(){
  if(!authenticated){render();status('请先登录 OneDrive');return;}
  const current=++version;status('正在读取文件…');
  try{const query=$('search').value.trim();const data=await request(query?'search':'list',{parent:crumbs.at(-1).id,query});if(current!==version)return;folder=data.folder;items=data.items;selected.clear();anchor=-1;loaded=true;render();status(query?`搜索结果 ${items.length} 项`:`${items.length} 项 · 双击文件夹进入，双击文件打开本地副本 · ⌘C 下载并复制到 Finder`);}catch(error){if(current===version)status(error.message,true);}
 }
 function navigate(next){crumbs=next;$('search').value='';selected.clear();items=[];folder=null;render();refresh();}
 function enter(item){navigate([...crumbs,{id:item.id,name:item.name}]);}
 function up(){if(crumbs.length>1)navigate(crumbs.slice(0,-1));}
 function ask(title,{value='',description='',text,ok='确定',input=true}={}){
  if($('dialog').open)return Promise.resolve(null);
  $('dialog-title').textContent=title;$('dialog-description').textContent=description;$('dialog-name').value=value;$('dialog-name').hidden=!input;$('dialog-text').hidden=text===undefined;$('dialog-text').value=text??'';$('dialog-ok').textContent=ok;
  return new Promise(resolve=>{$('dialog').onclose=()=>resolve($('dialog').returnValue==='ok'?{value:$('dialog-name').value,text:$('dialog-text').value}:null);$('dialog').returnValue='cancel';$('dialog').showModal();(text!==undefined?$('dialog-text'):input?$('dialog-name'):$('dialog-ok')).focus();});
 }
 async function work(action){if(busy)return;busy=true;render();try{await action();}catch(error){status(error.message,true);}finally{busy=false;render();}}
 async function mutation(op,data){await request(op,data);await refresh();}
 async function download(open=false){const ids=picked().map(x=>x.id);if(!ids.length)return;await work(async()=>{status('正在下载，完成后会复制到系统剪贴板…');const data=await request('download',{ids,copy:!open,open});status(open?`已打开本地副本。修改后请重新上传。保存于 ${data.directory}`:`已下载 ${ids.length} 项并复制，可在 Finder 中 ⌘V 粘贴。保存于 ${data.directory}`);});}
 async function rename(){const item=picked()[0];if(!item)return;const answer=await ask('重命名',{value:item.name});if(answer)await work(()=>mutation('rename',{id:item.id,etag:item.eTag,name:answer.value}));}
 async function remove(){const targets=picked();if(!targets.length)return;const answer=await ask(`删除 ${targets.length} 项？`,{input:false,description:targets.map(x=>x.name).join('、')+'。文件夹内的内容也会删除，可从 OneDrive 回收站恢复。',ok:'删除'});if(answer)await work(async()=>{try{for(const item of targets)await request('delete',{id:item.id,etag:item.eTag});}finally{await refresh();}});}
 async function edit(){const item=picked()[0];if(!item||item.folder)return;await work(async()=>{status('正在读取文本…');const data=await request('read',{id:item.id});const answer=await ask(item.name,{input:false,text:data.text,description:'UTF-8 文本 · 保存会更新 OneDrive 原文件',ok:'保存到 OneDrive'});if(answer&&answer.text!==data.text)await mutation('save',{id:item.id,etag:data.item.eTag,text:answer.text});else status('查看完成');});}
 async function create(isFolder){const target=parent();const answer=await ask(isFolder?'新建文件夹':'新建文本文件',{value:isFolder?'新建文件夹':'未命名.txt',...(isFolder?{}:{text:''})});if(answer)await work(async()=>{if(isFolder)await mutation('mkdir',{parent:target,name:answer.value});else{const encoded=new TextEncoder().encode(answer.text);if(encoded.length>20*1024*1024)throw Error('文件最大支持 20 MB');let binary='';for(let i=0;i<encoded.length;i+=8192)binary+=String.fromCharCode(...encoded.subarray(i,i+8192));await mutation('upload',{parent:target,name:answer.value,data:btoa(binary)});}});}
 $('login').onclick=()=>window.cnote.action('login');$('up').onclick=up;$('refresh').onclick=refresh;$('mkdir').onclick=()=>create(true);$('new').onclick=()=>create(false);$('download').onclick=()=>download();$('open').onclick=()=>download(true);$('rename').onclick=rename;$('delete').onclick=remove;$('edit').onclick=edit;
 $('move').onclick=async()=>{const item=picked()[0];if(!item)return;const answer=await ask('移动到文件夹',{value:'/',description:'输入从 OneDrive 根目录开始的目录路径，例如 /Documents。输入 / 移到根目录。'});if(answer)await work(()=>mutation('move',{id:item.id,etag:item.eTag,destination:answer.value}));};
 $('sort').onchange=render;$('order').onclick=()=>{ascending=!ascending;$('order').textContent=ascending?'↑ 升序':'↓ 降序';render();};
 $('search-form').onsubmit=event=>{event.preventDefault();refresh();};$('search').onsearch=()=>{if(!$('search').value)refresh();};
 $('upload').onclick=()=>$('files').click();$('files').onchange=()=>{const files=[...$('files').files],target=parent();$('files').value='';work(async()=>{try{for(const file of files){if(file.size>20*1024*1024)throw Error(`${file.name} 超过 20 MB 上传限制`);status('正在上传 '+file.name);const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));await request('upload',{parent:target,name:file.name,data:btoa(binary)});}}finally{await refresh();}});};
 function shortcut(command){
  if(window.cnoteTools?.workspace!==5||$('dialog').open||document.activeElement?.closest('input,textarea,[contenteditable=true]'))return false;
  if(command==='copy'){download();return true;}
  if(command==='selectAll'){selected=new Set(visible.map(x=>x.id));render();return true;}
  if(command==='open'){download(true);return true;}
  if(command==='find'){$('search').focus();$('search').select();return true;}
  return false;
 }
 document.addEventListener('copy',event=>{if(shortcut('copy'))event.preventDefault();});
 document.addEventListener('keydown',event=>{
  if(window.cnoteTools?.workspace!==5||event.isComposing||$('dialog').open)return;
  if((event.metaKey||event.ctrlKey)&&!event.altKey){const cmd={c:'copy',a:'selectAll',f:'find',o:'open'}[event.key.toLowerCase()];if(cmd&&shortcut(cmd)){event.preventDefault();event.stopImmediatePropagation();return;}}
  if(event.target.closest('input,textarea,select,button,[contenteditable=true]')||busy)return;
  if(event.metaKey&&event.key==='ArrowUp'){event.preventDefault();up();return;}
  if(event.metaKey&&event.key==='Backspace'){event.preventDefault();remove();return;}
  if(event.key==='Enter'){event.preventDefault();const item=picked()[0];item?.folder?enter(item):rename();return;}
  if(event.key===' '){event.preventDefault();edit();return;}
  if(['ArrowDown','ArrowUp'].includes(event.key)&&visible.length){event.preventDefault();anchor=Math.max(0,Math.min(visible.length-1,anchor+(event.key==='ArrowDown'?1:-1)));if(!event.shiftKey)selected.clear();selected.add(visible[anchor].id);render();$('list').querySelector(`[data-id="${CSS.escape(visible[anchor].id)}"]`)?.scrollIntoView({block:'nearest'});}
 });
 window.cnoteDrive={receive,account,refresh,shortcut,show(){render();if(!loaded)refresh();$('list').focus();}};
})();
