'use strict';
// Shared by the editor, table grid and offline worker.
((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.cnoteTableText=api;})(globalThis,()=>{
 function csv(source,delimiter='auto'){
  const text=source.replace(/^\uFEFF/,'');if(!text)return [];
  if(delimiter==='auto'){
   let quoted=false;const counts={',':0,'\t':0,';':0};
   for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){i++;continue;}quoted=!quoted;}else if(!quoted){if(c==='\n'||c==='\r')break;if(c in counts)counts[c]++;}}
   delimiter=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
  }
  if(delimiter.length!==1)throw Error('分隔符必须是单个字符');
  const rows=[];let row=[],value='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
   const c=text[i];
   if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
   if(c===delimiter){row.push(value);value='';closed=false;}
   else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);rows.push(row);row=[];value='';closed=false;}
   else if(c==='"'&&value===''&&!closed)quoted=true;
   else {if(closed||c==='"')throw Error('CSV 引号格式错误');value+=c;}
  }
  if(quoted)throw Error('CSV 存在未闭合引号');
  if(value!==''||row.length||closed){row.push(value);rows.push(row);}
  return rows;
 }
 function width(char){
  const n=char.codePointAt(0);
  if(/\p{Mark}/u.test(char)||n===0x200d||n===0xfe0f)return 0;
  return n>=0x1100&&(n<=0x115f||n===0x2329||n===0x232a||(n>=0x2e80&&n<=0xa4cf)||(n>=0xac00&&n<=0xd7a3)||(n>=0xf900&&n<=0xfaff)||(n>=0xfe10&&n<=0xfe19)||(n>=0xfe30&&n<=0xfe6f)||(n>=0xff01&&n<=0xff60)||(n>=0xffe0&&n<=0xffe6)||(n>=0x1f300&&n<=0x1faff)||n>=0x20000)?2:1;
 }
 function terminal(source){
  const lines=source.replace(/^\uFEFF/,'').replace(/&#(?:x20|32);/gi,' ').replace(/\u00a0/g,' ').replace(/\\(?=\r?$)/gm,'').split(/\r?\n/);
  const rule=line=>/^\s*[-─━=]{2,}(?:\s+[-─━=]{2,})+\s*$/.test(line);
  const index=lines.findIndex(rule);if(index<0)return null;
  const spans=[...lines[index].matchAll(/[-─━=]+/g)].map(m=>({start:m.index,end:m.index+m[0].length}));
  const rows=[];let pending=null;
  const flush=()=>{if(pending){rows.push(pending);pending=null;}};
  for(const line of lines){
   if(rule(line)){flush();continue;}if(!line.trim())continue;
   const cells=spans.map(()=>'');let column=0,position=0;
   for(const char of line){while(column+1<spans.length&&position>=spans[column+1].start)column++;if(position>=spans[column].start)cells[column]+=char;position+=width(char);}
   for(let i=0;i<cells.length;i++)cells[i]=cells[i].trim();
   if(!pending)pending=cells;else for(let i=0;i<cells.length;i++)if(cells[i])pending[i]+=(pending[i]?'\n':'')+cells[i];
  }
  flush();return rows.length?rows:null;
 }
 function detect(text){
  if(typeof text!=='string'||text.length>20*1024*1024)return null;
  const rich=terminal(text);if(rich&&rich[0].length>1)return rich;
  try{const rows=csv(text);const columns=rows[0]?.length||0;
   // Single-line prose containing commas is intentionally left as text.
   if(columns>1&&(rows.length>1||text.includes('\t'))&&rows.every(row=>row.length===columns))return rows;
  }catch{}
  return null;
 }
 return {csv,terminal,detect};
});
