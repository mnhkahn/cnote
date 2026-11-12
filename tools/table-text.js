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
 function detect(text){
  if(typeof text!=='string'||text.length>20*1024*1024)return null;
  try{const rows=csv(text);const columns=rows[0]?.length||0;
   // Single-line prose containing commas is intentionally left as text.
   if(columns>1&&(rows.length>1||text.includes('\t'))&&rows.every(row=>row.length===columns))return rows;
  }catch{}
  return null;
 }
 return {csv,detect};
});
