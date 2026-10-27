'use strict';
(() => {
 const $=id=>document.getElementById(id),post=value=>window.ipc.postMessage(JSON.stringify(value));
 let state={text:'',left:'',right:'',tableInput:'',rows:[]},restored=false,restoreRequested=false,workspace=0,seq=0,saved=0,sent=0,saveTimer=null,retryTimer=null,barrierCallback=null;
 let textEditor,resultEditor,leftEditor,rightEditor,lastEditor,suppress=false,diffTimer=null,diffResult={rows:[],addedText:'',removedText:''},diffPage=0,tablePage=0,columnPage=0,selectedRow=1;
 let textPreview=null,textVersion=0,textRequest=0,applyingText=false,textCountTimer=null,resultReady=false;
 const textPatterns={filter:'',remove:'',newline:''};
 const textOperations={
  format:{description:'整理 JSON、XML 或 SQL 的缩进。AI 文本可修复复制时产生的断行；不确定类型时可先自动识别。',before:'{"name":"CNote","local":true}',after:'{\n  "name": "CNote",\n  "local": true\n}'},
  compact:{description:'移除 JSON 中多余的空白和换行，字符串里的空格会保留。需要输入有效的 JSON。',before:'{\n  "name": "CNote"\n}',after:'{"name":"CNote"}'},
  'trim-empty':{description:'删除空行和只有空格的行，其余行的内容与顺序保持不变。',before:'苹果\n\n香蕉\n  \n橙子',after:'苹果\n香蕉\n橙子'},
  join:{description:'去掉所有换行和每行首尾空格，直接连接为一行。英文单词之间不会自动加空格。',before:'第一行\n第二行\n第三行',after:'第一行第二行第三行'},
  sort:{description:'将每行视为一项，按字符顺序排列。不是按数值大小或拼音排序。',before:'banana\napple\ncherry',after:'apple\nbanana\ncherry'},
  unique:{description:'先按字符顺序排序，再删除完全相同的重复行。原有顺序会改变。',before:'banana\napple\nbanana',after:'apple\nbanana'},
  filter:{description:'逐行匹配正则表达式，只保留匹配到的整行。输入关键词也可以直接筛选。',before:'成功：已保存\n错误：网络断开\n成功：已同步',after:'错误：网络断开',pattern:'^错误'},
  remove:{description:'删除原文中所有完全匹配的指定文本。按普通文本查找，不使用正则表达式。',before:'#苹果 #香蕉',after:'苹果 香蕉',pattern:'#'},
  newline:{description:'把所有完全匹配的指定文本替换成换行。适合将分隔的内容拆成多行。',before:'苹果,香蕉,橙子',after:'苹果\n香蕉\n橙子',pattern:','},
  cut:{description:'每行按相同的分隔符拆开，只取指定列。适合简单的分隔文本。',before:'小明,北京,12\n小红,上海,13',after:'北京\n上海',delimiter:',',field:'2'}
 };
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
 // atob returns bytes, not UTF-8 text. Treating it as text corrupts Ace's · into Â·.
 function decodeAsset(id){return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob($(id).textContent),c=>c.charCodeAt(0)));}
 function displayWhitespace(instance,visible){
  if(!instance)return;
  instance.renderer.$textLayer.SPACE_CHAR=visible?'\u00b7':' ';
  instance.renderer.$textLayer.TAB_CHAR='\u2192';
  instance.setShowInvisibles(visible);instance.renderer.updateFull(true);
 }
 function loadAce(){
  if(window.ace)return;
  const script=document.createElement('script');script.textContent=decodeAsset('tool-ace-source');document.head.append(script);script.remove();
  ace.config.set('basePath','');
 }
 function editor(id,value,field){
  loadAce();const instance=ace.edit(id);instance.setTheme('ace/theme/github');instance.setOptions({fontSize:14,showPrintMargin:false,useWorker:false,wrap:true,enableMultiselect:true});
  displayWhitespace(instance,workspace===1&&$('text-show-whitespace').checked);instance.session.setUseWorker(false);instance.setValue(value,-1);instance.on('focus',()=>lastEditor=instance);instance.on('change',()=>{if(!suppress&&field!=='result'){dirtyEditors.add(field);if(field!=='text')queueDiff();else{if(!applyingText)invalidateText('原文已修改，请重新预览。');updateTextInput();}markDirty();}});
  return instance;
 }
 function ensureEditors(){
  if(workspace===1&&!textEditor){textEditor=editor('tool-text-editor',state.text,'text');resultEditor=editor('tool-text-result','','result');resultEditor.setReadOnly(true);resultEditor.setOptions({highlightActiveLine:false,highlightGutterLine:false});configureText();updateTextInput();}
  if(workspace===2&&!leftEditor){leftEditor=editor('tool-diff-left',state.left,'left');rightEditor=editor('tool-diff-right',state.right,'right');queueDiff();}
 }
 function setText(instance,value){suppress=true;instance.session.setValue(value);suppress=false;}
 function show(index){
  workspace=index;document.body.classList.toggle('tools-open',index!==0);$('local-tools').hidden=index===0;
  for(const [i,id]of [[1,'text-tool'],[2,'diff-tool'],[3,'csv-tool']])$(id).hidden=index!==i;
  if(!index){if(!document.getElementById('document').hidden)window.cnote?.focusEditor();return;}
  $('local-tools').inert=!restored;if(!restored){if(!restoreRequested){restoreRequested=true;post({type:'tool_ready'});}status('正在读取本地工具草稿…');return;}
  ensureEditors();
  if(index===1){textEditor.resize();resultEditor.resize();textEditor.focus();}
  if(index===2){leftEditor.resize();rightEditor.resize();leftEditor.focus();}
  if(index===3){renderTable();$('table-input').focus();}
 }
 function run(kind,task,data){
  let job=jobs.get(kind);
  if(job?.cancel){job.cancel();job.worker.terminate();jobs.delete(kind);job=null;}
  if(!job){
   const code=decodeAsset('tool-worker-source'),url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
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
 function textFeedback(message,error=false){$('text-feedback').textContent=message;$('text-feedback').dataset.error=String(error);}
 function invalidateText(message='设置已修改，请重新预览。'){
  textVersion++;textPreview=null;resultReady=false;
  $('text-apply').disabled=true;$('text-copy-result').disabled=true;
  if(resultEditor)setText(resultEditor,'');$('text-result-placeholder').hidden=false;$('text-output-count').textContent='';
  $('text-decode-layers').replaceChildren();
  if(message)textFeedback(message);
 }
 function updateTextInput(){
  if(!textEditor)return;
  const empty=textEditor.session.getLength()===1&&textEditor.session.getLine(0)==='';
  $('text-input-placeholder').hidden=!empty;$('text-example-load').disabled=!empty;
  $('text-example-load').title=empty?'将左侧示例填入原文':'原文为空时可以填入示例';
  clearTimeout(textCountTimer);textCountTimer=setTimeout(()=>{
   $('text-input-count').textContent=`${textEditor.session.getLength()} 行 · ${textEditor.getValue().length.toLocaleString()} 字符`;
   $('text-undo').disabled=!textEditor.session.getUndoManager().hasUndo();
  },100);
 }
 function exampleForText(){
  const op=$('text-operation').value,config=textOperations[op];
  if(op!=='format')return config;
  return ({
   smartdecode:{before:'JUU0JUJEJUEwJUU1JUE1JUJE',after:'你好'},
   'ai-text':{before:'复制的文字被截\n    断了。\n\n    Hello\n    world',after:'复制的文字被截断了。\n\nHello world'},
   xml:{before:'<note><title>CNote</title></note>',after:'<note>\n  <title>CNote</title>\n</note>'},
   sql:{before:'select name from notes where id = 1',after:'SELECT\n  name\nFROM\n  notes\nWHERE\n  id = 1'},
   text:{before:'纯文本保留原有内容。',after:'纯文本保留原有内容。'}
  })[$('text-mode').value]||config;
 }
 function configureText(){
  const op=$('text-operation').value,config=textOperations[op],pattern=['filter','remove','newline'].includes(op);
  $('text-description').textContent=op==='format'&&$('text-mode').value==='smartdecode'?'自动识别 URL、Unicode 转义、HTML 实体、Base64、Base32 和 Hex，最多逐层解码 20 次。先预览结果和解码过程，再决定是否应用到原文。':config.description;
  $('text-format-settings').hidden=op!=='format';$('text-pattern-settings').hidden=!pattern;$('text-column-settings').hidden=op!=='cut';
  $('text-pattern-label').textContent=op==='filter'?'保留哪些行（正则表达式）':op==='remove'?'要删除的文本':'要替换为换行的文本';
  $('text-pattern').placeholder=config.pattern||'';if(pattern)$('text-pattern').value=textPatterns[op];
  $('text-pattern-help').textContent=op==='filter'?'例如 ^错误：保留以“错误”开头的行。无需输入两侧的 /。':'完全匹配输入的文本，区分大小写。';
  const example=exampleForText();$('text-example-before').textContent=example.before;$('text-example-after').textContent=example.after;
  invalidateText('先粘贴原文，再点击“预览处理结果”。');
  if(textEditor){textEditor.resize();resultEditor.resize();}
 }
 async function textAction(){
  if(!restored||!textEditor)return;
  captureEditors();const original=state.text,op=$('text-operation').value,version=textVersion;
  if(!original.length){textFeedback('请先在原文区域粘贴文本，或填入左侧示例。',true);textEditor.focus();return;}
  if(['filter','remove','newline'].includes(op)&&!$('text-pattern').value){textFeedback('请先填写左侧的'+$('text-pattern-label').textContent+'。',true);$('text-pattern').focus();return;}
  const request=++textRequest;
  $('text-apply').disabled=true;$('text-preview').disabled=true;$('text-preview').textContent='正在预览…';textFeedback('正在处理，原文保持不变…');
  try{
   const decoding=op==='format'&&$('text-mode').value==='smartdecode';
   const decoded=decoding?await run('text','smartDecode',{text:original}):null;
   const value=decoding?decoded.result:await run('text','textOp',{text:original,op,pattern:$('text-pattern').value,delimiter:$('text-delimiter').value,field:$('text-field').value,mode:$('text-mode').value});
   captureEditors();if(version!==textVersion||state.text!==original){status('处理期间内容或设置已修改，已保留新输入');textFeedback('原文或设置已修改，请重新预览。');return;}
   textPreview={original,value,version};resultReady=true;setText(resultEditor,value);$('text-result-placeholder').hidden=true;
   const before=original.split('\n').length,after=value.split('\n').length;
   $('text-output-count').textContent=`${after} 行 · ${value.length.toLocaleString()} 字符`;
   $('text-apply').disabled=value===original;$('text-copy-result').disabled=false;
   const label=$('text-operation').selectedOptions[0].textContent;
   textFeedback(value===original?'预览完成：内容无需修改。':`${label}：${before} 行 → ${after} 行，${original.length.toLocaleString()} → ${value.length.toLocaleString()} 字符。可复制结果，或应用到原文。`);
   if(decoded){
    const message=decoded.layers.length?`已自动解码 ${decoded.layers.length} 层：${decoded.layers.join(' → ')}。${decoded.limited?'已达 20 层上限。':''}可复制结果，或应用到原文。`:'未识别到可安全解码的内容，结果与原文一致。';
    textFeedback(message);const fragment=document.createDocumentFragment();
    decoded.steps.forEach((step,index)=>{const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=`第 ${index+1} 层 · ${step.name}`;pre.textContent=step.value+(step.truncated?'\n…（仅预览前 20,000 字符，最终结果保持完整）':'');details.append(summary,pre);fragment.append(details);});$('text-decode-layers').replaceChildren(fragment);
   }

  }catch(error){if(error.message!=='cancelled'){invalidateText('');textFeedback(`处理失败：${error.message}。请检查左侧设置，原文已保留。`,true);}}
  finally{if(request===textRequest){$('text-preview').disabled=false;$('text-preview').textContent='预览处理结果';}}
 }
 function applyText(){
  captureEditors();const preview=textPreview;
  if(!preview||preview.version!==textVersion||preview.original!==state.text){invalidateText('原文或设置已修改，请重新预览。');return;}
  const doc=textEditor.session.getDocument(),last=doc.getLength()-1;
  applyingText=true;
  try{textEditor.session.markUndoGroup();textEditor.session.replace(new (ace.require('ace/range').Range)(0,0,last,doc.getLine(last).length),preview.value);textEditor.session.markUndoGroup();}finally{applyingText=false;}
  textPreview=null;$('text-apply').disabled=true;
  textFeedback('已应用到原文，自动保存中。可点击“撤销”或按 ⌘Z 恢复。');status('已应用处理结果 · ⌘Z 可撤销');
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
 $('text-show-whitespace').onchange=()=>{const visible=$('text-show-whitespace').checked;displayWhitespace(textEditor,visible);displayWhitespace(resultEditor,visible);};
 $('text-preview').onclick=textAction;$('text-apply').onclick=applyText;
 $('text-operation').onchange=configureText;$('text-mode').onchange=configureText;
 for(const id of ['text-pattern','text-delimiter','text-field'])$(id).oninput=()=>{if(id==='text-pattern')textPatterns[$('text-operation').value]=$(id).value;invalidateText();};
 $('text-undo').onclick=()=>{textEditor?.undo();textEditor?.focus();};
 $('text-copy-result').onclick=()=>{if(resultReady)copy(resultEditor.getValue());};
 $('text-example-load').onclick=()=>{captureEditors();if(state.text.length)return;const example=exampleForText();const config=textOperations[$('text-operation').value];if(config.pattern!==undefined){$('text-pattern').value=config.pattern;textPatterns[$('text-operation').value]=config.pattern;}if(config.delimiter!==undefined)$('text-delimiter').value=config.delimiter;if(config.field!==undefined)$('text-field').value=config.field;textEditor.session.insert({row:0,column:0},example.before);textEditor.focus();textFeedback('示例已填入，点击“预览处理结果”试试。');};
 for(const button of document.querySelectorAll('[data-diff-op]'))button.onclick=()=>diffAction(button.dataset.diffOp);
 for(const button of document.querySelectorAll('[data-table-op]'))button.onclick=()=>tableAction(button.dataset.tableOp,button.dataset.ascending!=='false');
 $('text-copy').onclick=()=>{captureEditors();copy(state.text);};$('text-pattern').onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();textAction();}};
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
  if(workspace===3&&key==='z'&&!event.target.closest('input,textarea,[contenteditable=true]')){event.preventDefault();event.stopImmediatePropagation();$(event.shiftKey?'table-redo':'table-undo').click();}
 },true);
 function edit(command){
  const focused=document.activeElement;
  if(focused?.matches('input:not(.ace_text-input),textarea:not(.ace_text-input),[contenteditable=true]')){document.execCommand(command);return;}
  if(workspace===3&&(command==='undo'||command==='redo')){$(command==='undo'?'table-undo':'table-redo').click();return;}
  const instance=workspace===1?(lastEditor===resultEditor?resultEditor:textEditor):workspace===2?lastEditor:null;
  if(instance&&(command==='undo'||command==='redo')){if(instance!==resultEditor)instance[command]();return;}
  if(instance&&command==='selectAll'){instance.selectAll();instance.focus();return;}
  document.execCommand(command);
 }
 window.cnoteTools={compareNote:data=>run('note-conflict','noteCompare',data),show,receive,barrier,flush,edit,get workspace(){return workspace;},get state(){captureEditors();return state;}};
 // Read tool drafts only on the first tool switch; note startup stays independent.
})();
