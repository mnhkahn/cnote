const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
// Exercise the real UI controller without a browser or live account credentials.
class Element {
 constructor(tag,text=''){this.tagName=tag;this.textContent=text;this.children=[];this.value='';this.disabled=false;this.open=false;this.events={};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(){}
 addEventListener(name,fn){this.events[name]=fn;}
 querySelector(){return null;}
 querySelectorAll(){return [];}
 get options(){return this.children;}
 set selectedIndex(index){this.value=this.options[index].value;}
 showModal(){this.open=true;}
 close(){this.open=false;}
 remove(){this.removed=true;}
}
const tick=async()=>{for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));};
function fixture({linked=false,fail=false,hold=false,supported=true}={}){
 let rejectSave=false;
 const root=new Element('section'),body=new Element('body'),messages=[],deferred=[],state={trelloBoard:'a'.repeat(24)};
 const window={cnoteTools:{state,setTrelloBoard(id){state.trelloBoard=id;}},ipc:{postMessage(raw){const m=JSON.parse(raw);messages.push(m);
  if(m.type!=='trello')return;
  const answer=()=>{if(rejectSave&&m.op==='link_account'){rejectSave=false;window.cnoteTrello.receive({request:m.request,error:'保存失败，请重试'});return;}let data;if(m.op==='status')data={connected:true,account_linking:supported,account_id:m.account_id||current,linked};
   else if(m.op==='link_status')data={account_name:'微软家长',member:{id:'member-a',fullName:'作业家长'},boards:[{id:'a'.repeat(24),name:'嘉嘉',closed:false}]};
   else if(m.op==='link_account'){linked=true;data={linked:true,board:m.id};}
   if(fail&&m.op==='link_status')window.cnoteTrello.receive({request:m.request,error:'网络暂不可用'});
   else window.cnoteTrello.receive({request:m.request,data});};
  if(hold)deferred.push(answer);else queueMicrotask(answer);
 }}};
 let current='microsoft-a';
 const document={body,hidden:false,createElement:tag=>new Element(tag),getElementById:id=>id==='trello-tool'?root:null,addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../tools/trello.js'),'utf8'),{window,document,Option:class extends Element{constructor(text,value){super('option',text);this.value=value;}},URL,setTimeout,clearTimeout,Date,Map,Set,console});
 return {window,messages,body,state,deferred,failNextSave(){rejectSave=true;},account(id='microsoft-a'){current=id;window.cnoteTrello.account(!!id,id);},dialog(){return body.children.find(e=>e.tagName==='dialog'&&!e.removed);}};
}
test('existing logins prompt once, verify and save without another authorization',async()=>{
 const f=fixture();f.account();await tick();const dialog=f.dialog();assert.ok(dialog?.open);
 assert.ok(dialog.children.some(e=>e.textContent.includes('微软家长')));assert.ok(dialog.children.some(e=>e.textContent.includes('作业家长')));
 const confirm=dialog.children.find(e=>e.textContent==='关联并继续');await confirm.onclick();await tick();
 const saved=f.messages.find(m=>m.op==='link_account');assert.equal(saved.account_id,'microsoft-a');assert.equal(saved.member_id,'member-a');assert.equal(saved.id,'a'.repeat(24));assert.equal(f.dialog(),undefined);
 f.account();await tick();assert.equal(f.messages.filter(m=>m.op==='link_status').length,1);assert.ok(!f.messages.some(m=>m.op==='authorize'||m.op==='connect'));
});
test('later dismisses for the session and a new launch can prompt again',async()=>{
 const f=fixture();f.account();await tick();f.dialog().children.find(e=>e.textContent==='稍后').onclick();f.account();await tick();assert.equal(f.dialog(),undefined);assert.ok(!f.messages.some(m=>m.op==='link_account'));
 const restarted=fixture();restarted.account();await tick();assert.ok(restarted.dialog()?.open);
});
test('a persisted association suppresses the startup prompt',async()=>{
 const f=fixture({linked:true});f.account();await tick();assert.equal(f.dialog(),undefined);assert.ok(!f.messages.some(m=>m.op==='link_status'));
});
test('network failure keeps credentials and does not start authorization',async()=>{
 const f=fixture({fail:true});f.account();await tick();assert.equal(f.dialog(),undefined);assert.ok(!f.messages.some(m=>['disconnect','connect','authorize'].includes(m.op)));
});
test('switching Microsoft accounts closes an old confirmation without saving',async()=>{
 const f=fixture();f.account();await tick();const previous=f.dialog();f.account('microsoft-b');await tick();assert.equal(previous.removed,true);assert.ok(!f.messages.some(m=>m.op==='link_account'));assert.ok(f.dialog()?.open);
});
test('a status response arriving after logout cannot open a linking dialog',async()=>{
 const f=fixture({hold:true});f.account();f.account('');f.deferred.shift()();await tick();assert.equal(f.dialog(),undefined);assert.ok(!f.messages.some(m=>m.op==='link_status'));
});

test('failed confirmation stays open and can retry with existing authorization',async()=>{
 const f=fixture();f.account();await tick();const dialog=f.dialog(),confirm=dialog.children.find(e=>e.textContent==='关联并继续');
 f.failNextSave();await confirm.onclick();await tick();assert.equal(f.dialog(),dialog);assert.equal(confirm.disabled,false);assert.ok(dialog.children.some(e=>e.textContent==='保存失败，请重试'));
 await confirm.onclick();await tick();assert.equal(f.dialog(),undefined);assert.equal(f.messages.filter(m=>m.op==='link_account').length,2);
});
test('hosts without native linking support keep their existing login flow',async()=>{
 const f=fixture({supported:false});f.account();await tick();assert.equal(f.dialog(),undefined);assert.ok(!f.messages.some(m=>m.op==='link_status'));
});
