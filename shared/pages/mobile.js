/* Platform adapter only. Editor, Trello and OneDrive UI come from canonical sources. */
window.cnotePlatform={mobile:true};
window.ipc={postMessage:raw=>window.cnoteHost.postMessage(raw)};
(() => {
 const post=m=>ipc.postMessage(JSON.stringify(m));
 let state={},workspace=0,seq=0,saved=0,pendingBarrier=null,toolStateReady=false;
 const pending=new Map();let worker=null,jobId=0;
 function flush(){if(seq>saved)post({type:'tool_save',seq,state});}
 function settle(){if(pendingBarrier&&saved>=seq){const next=pendingBarrier;pendingBarrier=null;next();}}
 function show(index){
  if(![0,4,5].includes(index))return;
  if(index!==4)window.cnoteTrello?.hide();
  workspace=index;document.body.classList.toggle('tools-open',index!==0);
  document.getElementById('local-tools').hidden=index===0;
  document.getElementById('trello-tool').hidden=index!==4;document.getElementById('drive-tool').hidden=index!==5;
  document.querySelectorAll('[data-workspace]').forEach(b=>b.setAttribute('aria-selected',String(Number(b.dataset.workspace)===index)));
  document.getElementById('mobile-notes').hidden=index!==0;
  if(index===4&&toolStateReady)window.cnoteTrello.show();if(index===5)window.cnoteDrive.show();
 }
 window.cnoteTools={
  get workspace(){return workspace;},get state(){return state;},show,flush,
  setTrelloBoard(id){state.trelloBoard=id;seq++;flush();},
  barrier(next){pendingBarrier=next;flush();settle();},
  receive(e){if(e.type==='tool_state'){state=e.state||{};toolStateReady=true;if(workspace===4)window.cnoteTrello.show();}if(e.type==='tool_saved'){saved=Math.max(saved,e.seq);settle();}if(e.type==='tool_save_failed'){pendingBarrier=null;window.cnote.receive({type:'error',message:e.message});}},
  compareNote(data){
   if(!worker){
    const source=new TextDecoder().decode(Uint8Array.from(atob(document.getElementById('tool-worker-source').textContent),c=>c.charCodeAt(0)));
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
    worker.onmessage=e=>{const job=pending.get(e.data.id);if(!job)return;pending.delete(e.data.id);e.data.error?job.reject(Error(e.data.error)):job.resolve(e.data.result);};
    worker.onerror=()=>{for(const job of pending.values())job.reject(Error('差异计算失败'));pending.clear();worker.terminate();worker=null;};
   }
   return new Promise((resolve,reject)=>{const id=++jobId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('差异计算超时，请缩小内容后重试'));},6000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});worker.postMessage({id,task:'noteCompare',data});});
  }
 };
 window.cnoteMobile={
  receive(e){
   if(e.type==='trello'){window.cnoteTrello.receive(e.result);return;}
   if(e.type==='drive'){window.cnoteDrive.receive(e.result);return;}
   if(e.type==='selected'&&window.cnoteMobile.lastState){window.cnoteMobile.lastState.selected=e.id;window.cnoteMobile.receive(window.cnoteMobile.lastState);}
   if(e.type==='saved'&&window.cnoteMobile.lastState){const n=window.cnoteMobile.lastState.notes.find(n=>n.id===e.id);if(n){n.title=e.title||n.title;n.dirty=true;}window.cnoteMobile.receive(window.cnoteMobile.lastState);}
   if(e.type==='state'){
    const list=document.getElementById('mobile-note-list'),search=document.getElementById('mobile-search').value.toLowerCase();
    list.replaceChildren();
    for(const note of e.notes||[]){if(search&&!note.title.toLowerCase().includes(search))continue;const b=document.createElement('button');b.textContent=note.title+(note.conflict?' ⚠':'');b.dataset.id=note.id;b.classList.toggle('selected',note.id===e.selected);b.onclick=()=>{cnote.action('open',{id:note.id});document.getElementById('mobile-notes').classList.remove('expanded');};list.append(b);}
    const login=document.getElementById('mobile-login');login.textContent=e.authenticated?'退出 OneDrive':'登录 OneDrive';login.onclick=()=>cnote.action(e.authenticated?'logout':'login');
    window.cnoteDrive.account(e.authenticated,e.account);window.cnoteMobile.lastState=e;
   }
   window.cnote.receive(e);
  },
  flush(){window.cnote.flushAll();window.cnoteTools.flush();},
  back(){const modal=[...document.querySelectorAll('dialog[open]')].at(-1);if(modal){modal.dispatchEvent(new Event('cancel',{cancelable:true}))&&modal.close();return;}if(workspace){show(0);return;}const notes=document.getElementById('mobile-notes');if(!cnoteMobile.lastState?.selected||notes.classList.contains('expanded'))cnote.action('close');else notes.classList.add('expanded');},
  insertImage(src){const editor=document.getElementById('editor');if(!editor||window.cnoteTools.workspace)return;window.cnote.focusEditor();const image=document.createElement('img');image.src=src;image.alt='图片';document.execCommand('insertHTML',false,image.outerHTML);editor.dispatchEvent(new Event('input',{bubbles:true}));},
  featureMode(index){
   document.body.classList.add('feature-only');
   const tabs=document.getElementById('mobile-tabs');if(tabs)tabs.hidden=true;
   document.getElementById('mobile-notes').hidden=true;show(index);
  },
  lastState:null
 };
 document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-workspace]').forEach(b=>b.onclick=()=>{cnoteMobile.flush();show(Number(b.dataset.workspace));});
  document.getElementById('drive-download').textContent='下载 / 分享';document.getElementById('drive-open').textContent='下载后打开';
  document.getElementById('mobile-note-toggle').onclick=()=>document.getElementById('mobile-notes').classList.toggle('expanded');
  document.getElementById('mobile-new').onclick=()=>cnote.action('new');
  document.getElementById('mobile-sync').onclick=()=>cnote.action('save');
  document.getElementById('mobile-image').onclick=()=>post({type:'image'});
  document.getElementById('mobile-delete').onclick=()=>{const s=cnoteMobile.lastState,n=s?.notes?.find(n=>n.id===s.selected);if(n)cnote.action('delete',{id:n.id,title:n.title});};
  document.getElementById('mobile-update').onclick=()=>post({type:'check_update'});
  document.getElementById('mobile-search').oninput=()=>{if(cnoteMobile.lastState)cnoteMobile.receive(cnoteMobile.lastState);};
  post({type:'tool_ready'});post({type:'mobile_ready'});
 });
})();
