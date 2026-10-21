'use strict';
(() => {
 const $=id=>document.getElementById(id),post=value=>window.ipc.postMessage(JSON.stringify(value));
 let state={text:'',left:'',right:'',tableInput:'',rows:[]},restored=false,restoreRequested=false,workspace=0,seq=0,saved=0,sent=0,saveTimer=null,retryTimer=null,barrierCallback=null;
 let textEditor,leftEditor,rightEditor,lastEditor,suppress=false,diffTimer=null,diffResult={rows:[],addedText:'',removedText:''},diffPage=0,tablePage=0,columnPage=0,selectedRow=1;
 let history=[],future=[],draftDue=0;const dirtyEditors=new Set();const jobs=new Map(),pending=new Set(),ROW_PAGE=100,COL_PAGE=24,MAX=20*1024*1024;
 function status(message,error=false){$('tool-status').textContent=message;$('tool-status').dataset.error=String(error);}
 function guard(){post({type:'tool_guard',dirty:seq>saved||pending.size>0});}
 function markDirty(){if(suppress||!restored)return;if(seq===sent||!draftDue)draftDue=Date.now()+1000;seq++;guard();clearTimeout(saveTimer);saveTimer=setTimeout(flush,Math.min(300,Math.max(0,draftDue-Date.now())));}
 function captureEditors(){for(const field of dirtyEditors){const instance={text:textEditor,left:leftEditor,right:rightEditor}[field];if(instance)state[field]=instance.getValue();}dirtyEditors.clear();}
 function flush(){
  captureEditors();clearTimeout(saveTimer);if(seq<=saved||seq===sent)return;
  const snapshot=JSON.stringify(state);
  if(snapshot.length>MAX){status('工具草稿超过 20 MB，请先导出并缩小内容。关闭已暂停。',true);barrierCallback=null;return;}
  sent=seq;post({type:'tool_save',seq,state});
 }
 function settleBarrier(){if(barrierCallback&&pending.size===0){flush();if(seq<=saved){const next=barrierCallback;barrierCallback=null;next();}}}
 function barrier(next){barrierCallback=next;settleBarrier();}
 function receive(event){
  if(event.type==='tool_state'){
   if(restored)return;
   const source=event.state||{};state={text:String(source.text||''),left:String(source.left||''),right:String(source.right||''),tableInput:String(source.tableInput||''),rows:Array.isArray(source.rows)?source.rows:[]};
   restored=true;$('table-input').value=state.tableInput;$('local-tools').inert=false;
   if(workspace)show(workspace);status('草稿已从本机恢复 · 离线可用');
  }else if(event.type==='tool_saved'){
   saved=Math.max(saved,Math.min(seq,event.seq));guard();if(saved<seq){sent=saved;flush();}else{status('已保存到本机');settleBarrier();}
  }else if(event.type==='tool_save_failed'){
   sent=saved;barrierCallback=null;status('保存失败，草稿仍在内存中：'+event.message,true);clearTimeout(retryTimer);retryTimer=setTimeout(flush,3000);guard();
  }else if(event.type==='tool_export_done'){status(event.message,event.failed);}
 }
 function loadAce(){
  if(window.ace)return;
  const script=document.createElement('script');script.textContent=atob($('tool-ace-source').textContent);document.head.append(script);script.remove();
  ace.config.set('basePath','');
 }
 function editor(id,value,field){
  loadAce();const instance=ace.edit(id);instance.setTheme('ace/theme/github');instance.setOptions({fontSize:14,showPrintMargin:false,useWorker:false,wrap:true,enableMultiselect:true});
  instance.session.setUseWorker(false);instance.setValue(value,-1);instance.on('focus',()=>lastEditor=instance);instance.on('change',()=>{if(!suppress){dirtyEditors.add(field);if(field!=='text')queueDiff();markDirty();}});
  return instance;
 }
 function ensureEditors(){
  if(workspace===1&&!textEditor)textEditor=editor('tool-text-editor',state.text,'text');
  if(workspace===2&&!leftEditor){leftEditor=editor('tool-diff-left',state.left,'left');rightEditor=editor('tool-diff-right',state.right,'right');queueDiff();}
 }
 function setText(instance,value){suppress=true;instance.session.setValue(value);suppress=false;}
 function show(index){
  workspace=index;document.body.classList.toggle('tools-open',index!==0);$('local-tools').hidden=index===0;
  for(const [i,id]of [[1,'text-tool'],[2,'diff-tool'],[3,'csv-tool']])$(id).hidden=index!==i;
  if(!index){if(!document.getElementById('document').hidden)window.cnote?.focusEditor();return;}
  $('local-tools').inert=!restored;if(!restored){if(!restoreRequested){restoreRequested=true;post({type:'tool_ready'});}status('正在读取本地工具草稿…');return;}
  ensureEditors();
  if(index===1){textEditor.resize();textEditor.focus();}
  if(index===2){leftEditor.resize();rightEditor.resize();leftEditor.focus();}
  if(index===3){renderTable();$('table-input').focus();}
 }
 function run(kind,task,data){
  let job=jobs.get(kind);
  if(job?.cancel){job.cancel();job.worker.terminate();jobs.delete(kind);job=null;}
  if(!job){
   const code=atob($('tool-worker-source').textContent),url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
   try{job={worker:new Worker(url),id:0};}catch(error){URL.revokeObjectURL(url);status('后台处理器无法启动：'+error.message,true);throw error;}setTimeout(()=>URL.revokeObjectURL(url),1000);jobs.set(kind,job);
  }
  const current=job;let operation;
  operation=new Promise((resolve,reject)=>{
   const id=++current.id;current.reject=reject;
   const complete=()=>{clearTimeout(current.timer);current.reject=null;current.cancel=null;pending.delete(operation);setTimeout(()=>{guard();settleBarrier();},0);};
   current.cancel=()=>{complete();reject(Error('cancelled'));};
   current.worker.onmessage=event=>{if(event.data.id!==id)return;complete();event.data.error?reject(Error(event.data.error)):resolve(event.data.result);};
   current.worker.onerror=event=>{complete();reject(Error(event.message||'后台计算失败'));current.worker.terminate();jobs.delete(kind);};
   current.timer=setTimeout(()=>{complete();current.worker.terminate();jobs.delete(kind);reject(Error('处理超时，原始数据已保留，请缩小输入或简化表达式'));},5000);
   current.worker.postMessage({id,task,data},data?.bytes instanceof ArrayBuffer?[data.bytes]:[]);
  });
  pending.add(operation);guard();
  return operation.catch(error=>{if(error.message!=='cancelled')status(error.message,true);throw error;});
 }
 async function copy(value){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);status('已复制');return;}}catch{}
  const input=document.createElement('textarea');input.value=value;input.style.cssText='position:fixed;left:-10000px';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();status(ok?'已复制':'复制失败，请手动选择并复制',!ok);
 }
 async function textAction(op){
  if(!restored)return;
  captureEditors();const original=state.text;
  try{const value=await run('text','textOp',{text:original,op,pattern:$('text-pattern').value,delimiter:$('text-delimiter').value,field:$('text-field').value,mode:$('text-mode').value});
   captureEditors();if(state.text!==original){status('处理期间内容已修改，已保留新输入');return;}
   const doc=textEditor.session.getDocument(),last=doc.getLength()-1;
   textEditor.session.replace(new (ace.require('ace/range').Range)(0,0,last,doc.getLine(last).length),value);
   if(op==='format'){const mode=$('text-mode').value;if(['json','xml','sql'].includes(mode))textEditor.session.setMode('ace/mode/'+mode);}
   status('处理完成 · ⌘Z 可撤销');
  }catch{}
 }
 function queueDiff(){clearTimeout(diffTimer);diffTimer=setTimeout(compare,200);}
 async function compare(){
  if(!restored)return;captureEditors();const left=state.left,right=state.right;try{const result=await run('diff','compare',{left,right});captureEditors();if(state.left!==left||state.right!==right)return;diffResult=result;diffPage=0;renderDiff();status('对比完成');}catch{}
 }
 function renderDiff(){
  const rows=diffResult.rows,start=diffPage*ROW_PAGE,table=document.createElement('table');table.className='diff-table';
  for(const row of rows.slice(start,start+ROW_PAGE)){const tr=table.insertRow();tr.className=row.kind;for(const [value,className]of [[row.a,'line'],[row.left,''],[row.b,'line'],[row.right,'']]){const td=tr.insertCell();td.textContent=String(value);td.className=className;}}
  $('diff-output').replaceChildren(table);$('diff-count').textContent=`+${diffResult.added||0} / −${diffResult.removed||0}`;$('diff-page').textContent=`${diffPage+1} / ${Math.max(1,Math.ceil(rows.length/ROW_PAGE))}`;
  $('diff-prev').disabled=diffPage===0;$('diff-next').disabled=start+ROW_PAGE>=rows.length;
 }
 async function diffAction(op){
  captureEditors();const beforeLeft=state.left,beforeRight=state.right;
  try{const left=await run('diff-format','textOp',{text:beforeLeft,op}),right=await run('diff-format','textOp',{text:beforeRight,op});captureEditors();if(state.left!==beforeLeft||state.right!==beforeRight){status('处理期间内容已修改，已保留新输入');return;}state.left=left;state.right=right;setText(leftEditor,left);setText(rightEditor,right);markDirty();await compare();}catch{}
 }
 function remember(before,after){history.push({before,after});if(history.length>6)history.shift();future=[];}
 function replaceRows(rows){remember(state.rows,rows);state.rows=rows;tablePage=0;columnPage=0;selectedRow=1;markDirty();renderTable();}
 function renderTable(){
  const rows=state.rows,width=rows[0]?.length||0;tablePage=Math.min(tablePage,Math.max(0,Math.ceil((rows.length-1)/ROW_PAGE)-1));columnPage=Math.min(columnPage,Math.max(0,Math.ceil(width/COL_PAGE)-1));
  const start=1+tablePage*ROW_PAGE,end=Math.min(rows.length,start+ROW_PAGE),left=columnPage*COL_PAGE,right=Math.min(width,left+COL_PAGE),table=document.createElement('table');table.className='data-table';
  const cell=(row,y,x,header=false)=>{const td=document.createElement(header?'th':'td'),input=document.createElement('input');input.value=String(rows[y]?.[x]??'');input.setAttribute('aria-label',`${header?'表头':'第 '+y+' 行'}，第 ${x+1} 列`);input.dataset.row=y;input.dataset.column=x;
   let before;
   input.onfocus=()=>{selectedRow=y;before=state.rows;};
   input.oninput=()=>{const next=state.rows.slice();next[y]=next[y].slice();next[y][x]=input.value;state.rows=next;markDirty();};
   input.onchange=()=>{if(before&&before!==state.rows)remember(before,state.rows);if(header)renderColumns();};
   td.append(input);row.append(td);
  };
  if(rows.length){const head=document.createElement('thead'),tr=document.createElement('tr'),th=document.createElement('th');th.className='row-number';th.textContent='#';tr.append(th);for(let x=left;x<right;x++)cell(tr,0,x,true);head.append(tr);table.append(head);
   const body=document.createElement('tbody');for(let y=start;y<end;y++){const tr=document.createElement('tr'),number=document.createElement('td');number.textContent=y;number.className='row-number';number.onclick=()=>selectedRow=y;tr.append(number);for(let x=left;x<right;x++)cell(tr,y,x);body.append(tr);}table.append(body);
  }
  $('table-grid').replaceChildren(table);renderColumns();$('table-page').textContent=`${Math.max(0,rows.length-1)} 行 × ${width} 列 · 第 ${tablePage+1} 页 · 列 ${width?left+1:0}–${right}`;
  $('table-prev').disabled=tablePage===0;$('table-next').disabled=end>=rows.length;$('table-col-prev').disabled=columnPage===0;$('table-col-next').disabled=right>=width;
  $('table-undo').disabled=!history.length;$('table-redo').disabled=!future.length;
 }
 function renderColumns(){const old=$('table-column').value;$('table-column').replaceChildren(...(state.rows[0]||[]).map((name,i)=>{const option=document.createElement('option');option.value=i;option.textContent=(i+1)+': '+name;return option;}));$('table-column').value=String(Math.min(Number(old)||0,(state.rows[0]?.length||1)-1));}
 async function importData(text,format,bytes){
  if(format==='html'){
   const template=document.createElement('template');template.innerHTML=text;const table=template.content.querySelector('table');if(!table){status('HTML 中找不到表格',true);return;}
   const rows=[...table.rows].map(r=>[...r.cells].map(c=>c.textContent));replaceRows(rows);status('已导入 HTML 表格');return;
  }
  try{replaceRows(await run('table','importTable',{text,format,bytes}));status('已导入，第一行作为表头');}catch{}
 }
 async function tableAction(op,ascending=true){const original=state.rows;try{const rows=await run('table','tableOp',{rows:original,op,column:Number($('table-column').value),pattern:$('table-filter').value,ascending});if(state.rows!==original){status('处理期间表格已修改，已保留新输入');return;}replaceRows(rows);status('表格已更新 · 可撤销');}catch{}}
 async function exportData(copyOnly=false){
  try{const result=await run('table-export','exportTable',{rows:state.rows,format:$('table-export-format').value});
   if(copyOnly){if(result.bytes){status('Excel 为二进制格式，请使用导出；复制时可选择 CSV 或 JSON',true);return;}await copy(result.text);return;}
   const bytes=result.bytes||new TextEncoder().encode(result.text);if(bytes.length>MAX){status('导出超过 20 MB，请分批导出',true);return;}
   let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   post({type:'tool_export',filename:'CNote-table.'+result.extension,data:btoa(binary)});
  }catch{}
 }
 function printTable(){
  if(state.rows.length>5001){status('打印 / PDF 最多支持 5000 行，请筛选后打印或导出为 Excel',true);return;}
  const table=document.createElement('table');state.rows.forEach((row,i)=>{const tr=table.insertRow();for(const value of row){const td=document.createElement(i?'td':'th');td.textContent=value;tr.append(td);}});$('tool-print').replaceChildren(table);post({type:'print'});
 }
 for(const button of document.querySelectorAll('[data-text-op]'))button.onclick=()=>textAction(button.dataset.textOp);
 for(const button of document.querySelectorAll('[data-diff-op]'))button.onclick=()=>diffAction(button.dataset.diffOp);
 for(const button of document.querySelectorAll('[data-table-op]'))button.onclick=()=>tableAction(button.dataset.tableOp,button.dataset.ascending!=='false');
 $('text-copy').onclick=()=>{captureEditors();copy(state.text);};$('text-pattern').onkeydown=event=>{if(event.key==='Enter')textAction('filter');};
 $('diff-run').onclick=compare;$('diff-copy-removed').onclick=()=>copy(diffResult.removedText);$('diff-copy-added').onclick=()=>copy(diffResult.addedText);
 $('diff-prev').onclick=()=>{diffPage=Math.max(0,diffPage-1);renderDiff();};$('diff-next').onclick=()=>{diffPage++;renderDiff();};
 $('table-input').oninput=()=>{state.tableInput=$('table-input').value;markDirty();};
 $('table-open-file').onclick=()=>$('table-file').click();
 $('table-import').onclick=()=>importData($('table-input').value,$('table-import-format').value);
 $('table-file').onchange=async event=>{const file=event.target.files[0];if(!file)return;if(file.size>MAX){status('文件最大支持 20 MB',true);return;}const extension=file.name.split('.').at(-1).toLowerCase(),format={xlsx:'xlsx',json:'json',jsonl:'jsonl',ndjson:'jsonl',md:'markdown',html:'html',htm:'html',sql:'sql'}[extension]||'csv';if(format==='xlsx')await importData('',format,await file.arrayBuffer());else await importData(await file.text(),format);event.target.value='';};
 $('table-copy').onclick=()=>exportData(true);$('table-export').onclick=()=>exportData();$('table-print').onclick=printTable;
 $('table-undo').onclick=()=>{const change=history.pop();if(change){future.push(change);state.rows=change.before;markDirty();renderTable();}};
 $('table-redo').onclick=()=>{const change=future.pop();if(change){history.push(change);state.rows=change.after;markDirty();renderTable();}};
 $('table-prev').onclick=()=>{tablePage=Math.max(0,tablePage-1);renderTable();};$('table-next').onclick=()=>{tablePage++;renderTable();};
 $('table-col-prev').onclick=()=>{columnPage=Math.max(0,columnPage-1);renderTable();};$('table-col-next').onclick=()=>{columnPage++;renderTable();};
 $('table-add-row').onclick=()=>replaceRows(state.rows.length?[...state.rows,Array(state.rows[0].length).fill('')]:[['列1'],['']]);
 $('table-delete-row').onclick=()=>{if(selectedRow>0&&selectedRow<state.rows.length)replaceRows(state.rows.filter((_,i)=>i!==selectedRow));};
 $('table-add-column').onclick=()=>replaceRows(state.rows.length?state.rows.map((row,i)=>[...row,i?'':'列'+(row.length+1)]):[['列1']]);
 $('table-delete-column').onclick=()=>{const column=Number($('table-column').value);replaceRows(state.rows.map(row=>row.filter((_,i)=>i!==column)));};
 $('table-count').onclick=async()=>{try{const result=await run('stats','stats',{rows:state.rows,column:Number($('table-column').value)});$('table-stats').textContent=`非空 ${result.count} · 数值 ${result.numeric} · 合计 ${result.sum} · 均值 ${result.mean??'—'}`;}catch{}};
 document.addEventListener('keydown',event=>{
  if(!workspace||!(event.metaKey||event.ctrlKey)||event.isComposing)return;
  const key=event.key.toLowerCase();if(key==='s'){event.preventDefault();event.stopImmediatePropagation();flush();}
  if(workspace===3&&key==='z'){event.preventDefault();event.stopImmediatePropagation();$(event.shiftKey?'table-redo':'table-undo').click();}
 },true);
 function edit(command){
  if(workspace===3&&(command==='undo'||command==='redo')){$(command==='undo'?'table-undo':'table-redo').click();return;}
  const instance=workspace===1?textEditor:lastEditor;
  if(instance&&(command==='undo'||command==='redo')){instance[command]();return;}
  if(instance&&command==='selectAll'){instance.selectAll();instance.focus();return;}
  document.execCommand(command);
 }
 window.cnoteTools={show,receive,barrier,flush,edit,get workspace(){return workspace;},get state(){captureEditors();return state;}};
 // Read tool drafts only on the first tool switch; note startup stays independent.
})();
