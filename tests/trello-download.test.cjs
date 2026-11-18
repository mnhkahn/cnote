const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('tools/trello.js','utf8');
class Element {
 constructor(){this.children=[];this.style={};this.dataset={};this.value='';this.classList={toggle(){},add(){},remove(){}};}
 append(...children){this.children.push(...children);} replaceChildren(...children){this.children=children;}
 setAttribute(){} addEventListener(){} querySelectorAll(){return [];} querySelector(){return null;} remove(){} add(option){this.append(option);}
}
async function planner(fail){
 const elements=new Map(),calls=[];
 const document={hidden:false,getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element(),addEventListener(){}};
 class Today extends Date {constructor(...args){if(args.length)super(...args);else super(2026,10,18,12);}}
 const window={cnoteTools:{state:{trelloBoard:'board'},setTrelloBoard(){}},ipc:{postMessage(raw){
  const m=JSON.parse(raw);calls.push(m);queueMicrotask(()=>{
   const error=fail?.(m);if(error){window.cnoteTrello.receive({request:m.request,error:error.message,code:error.code});return;}
   const data={status:{connected:true},boards:{boards:[{id:'board',name:'作业'}]},board:{lists:[],cards:[
    {id:'today',name:'语文',due:'2026-11-18T10:00:00',closed:false},
    {id:'tomorrow',name:'数学',due:'2026-11-19T10:00:00',closed:false},
    {id:'archived',name:'已归档',due:'2026-11-18T10:00:00',closed:true}
   ]},homework_attachments:{files:[{id:'image',name:'2026-11-18_语文_图一.jpg'},{id:'audio',name:'2026-11-18_语文_音频一.m4a'}]},download_homework_attachment:{saved:true}}[m.op];
   window.cnoteTrello.receive({request:m.request,data});
  });
 }}};
 vm.runInNewContext(source,{window,document,Date:Today,Option:class extends Element {constructor(name,id){super();this.value=id;}},URL,Map,Set,AbortController,clearTimeout(){},setTimeout(){return 1;}});
 window.cnoteTrello.show();await new Promise(setImmediate);
 return {calls,control:document.getElementById('trello-download-homework'),status:document.getElementById('trello-message')};
}
test('button follows association settings and downloads only the selected date',async()=>{
 assert(source.indexOf('id="trello-download-homework"')>source.indexOf('id="trello-settings"'));
 const p=await planner();await p.control.onclick();
 const manifests=p.calls.filter(m=>m.op==='homework_attachments');assert.equal(manifests.length,1);
 assert.equal(manifests[0].id,'today');assert.equal(manifests[0].date,'2026-11-18');assert.equal(manifests[0].name,'语文');
 const files=p.calls.filter(m=>m.op==='download_homework_attachment');assert.equal(files.length,2);
 assert.equal(files[0].name,'2026-11-18_语文_图一.jpg');assert.equal(files[1].name,'2026-11-18_语文_音频一.m4a');
 assert.match(p.status.textContent,/已下载 2 个附件到下载目录\/CNote/);assert.equal(p.control.disabled,false);
});
test('partial failures continue and duplicate clicks do not start another batch',async()=>{
 const p=await planner(m=>m.op==='download_homework_attachment'&&m.attachment==='image'?{message:'文件下载失败'}:null);
 const first=p.control.onclick();await p.control.onclick();await first;
 assert.equal(p.calls.filter(m=>m.op==='homework_attachments').length,1);
 assert.match(p.status.textContent,/已下载 1 个附件/);assert.match(p.status.textContent,/1 项失败/);
});
test('storage permission denial stops the remaining downloads',async()=>{
 const p=await planner(m=>m.op==='download_homework_attachment'?{message:'未授予下载目录写入权限',code:'download_permission_denied'}:null);
 await p.control.onclick();assert.equal(p.calls.filter(m=>m.op==='download_homework_attachment').length,1);
 assert.match(p.status.textContent,/下载已停止/);assert.equal(p.control.disabled,false);
});
