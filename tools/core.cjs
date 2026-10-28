'use strict';
const {diffLines,diffArrays}=require('diff');
const {EntityDecoder,ALL_ENTITIES}=require('@nodable/entities');
const {zipSync,unzipSync,strToU8,strFromU8}=require('fflate');
const {XMLParser,XMLValidator}=require('fast-xml-parser');
const sqlFormatter=require('sql-formatter');
const xmlFormatter=require('xml-formatter');
const MAX=20*1024*1024;
function check(value){if(value.length>MAX)throw Error('单个工具最多支持 20 MB 数据');}
const lines=s=>s.split(/\r?\n/);
function prettyJSON(source){
 JSON.parse(source); // Validate only; format the original tokens to preserve large integers.
 const tokens=source.match(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g)||[];
 let depth=0,out='';const pad=()=> '  '.repeat(depth);
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i],previous=tokens[i-1],next=tokens[i+1];
  if(t==='{'||t==='['){out+=t;depth++;if(next!=='}'&&next!==']')out+='\n'+pad();}
  else if(t==='}'||t===']'){depth--;if(previous!=='{'&&previous!=='[')out+='\n'+pad();out+=t;}
  else if(t===',')out+=',\n'+pad();else if(t===':')out+=': ';else out+=t.startsWith('"')?JSON.stringify(JSON.parse(t)):t;
 }
 return out;
}
// 复制的 AI 文本通常从第二个非空行开始带有固定缩进。
function isAIText(content) {
    const lines = content.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim());
    if (lines.length < 2) return false;
    const indent = lines[1].match(/^[ \t\u3000]+/);
    return !!indent && lines.slice(1).every((line) => line.startsWith(indent[0]));
}

function formatAIText(content) {
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    const columnSeparator = /(?: {2,}|\t+|\u3000+)/;
    // 有序号及多列的记录是新行，其余行视为被硬换行截断的内容。
    const isRecord = (line) => /^\d+(?: {2,}|\t+|\u3000+)/.test(line) && line.split(columnSeparator).length >= 3;
    const table = lines.some((line) => isRecord(line.trim()));
    const result = [];
    let paragraphStart = true;
    lines.forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) {
            if (result.length && result[result.length - 1] !== "") result.push("");
            paragraphStart = true;
            return;
        }
        if (paragraphStart || (table && isRecord(line))) {
            result.push(line);
            paragraphStart = false;
            return;
        }
        const previous = result[result.length - 1];
        let separator = "";
        if (table && (/^https?:\/\//i.test(line) || (!/^\d/.test(previous) && columnSeparator.test(line)))) {
            separator = "    ";
        } else if (!/https?:\/\/\S*$/i.test(previous) && /[a-z0-9]$/i.test(previous) && /^[a-z0-9]/i.test(line)) {
            // 英文词间保留空格；中文和 URL 的断行直接接回。
            separator = " ";
        }
        result[result.length - 1] += separator + line;
    });
    return result.join("\n").trim();
}

function format(source,mode='auto',depth=0){
 check(source);if(mode==='smartdecode')return smartDecode({text:source}).result;if(!source.trim())return source;
 if(mode==='auto'){const t=source.trim();mode=/^[{[]/.test(t)?'json':t.startsWith('<')?'xml':isAIText(source)?'ai-text':/^(select|insert|update|delete|with|create|alter|drop)\b/i.test(t)?'sql':'text';
  if(mode==='text'&&depth<20&&/(?:\\u[0-9a-f]{4}|%[0-9a-f]{2})/i.test(source)){const decoded=decodeOne(source);if(decoded&&decoded.value!==source)return format(decoded.value,'auto',depth+1);}
 }
 if(mode==='ai-text')return formatAIText(source);
 if(mode==='json')return prettyJSON(source);
 if(mode==='xml'){const valid=XMLValidator.validate(source);if(valid!==true)throw Error(valid.err?.msg||'XML 格式错误');return xmlFormatter(source,{indentation:'  ',collapseContent:true,whiteSpaceAtEndOfSelfclosingTag:true});}
 if(mode==='sql')return sqlFormatter.format(source,{language:'sql',keywordCase:'upper',tabWidth:2});
 return source;
}
function textOp({text,op,pattern='',delimiter=',',field=1,mode='auto'}){
 check(text);
 switch(op){
  case 'format':return format(text,mode);
  case 'compact':return prettyJSON(text).replace(/"(?:\\[\s\S]|[^"\\])*"|\s+/g,m=>m.startsWith('"')?m:'');
  case 'trim-empty':return lines(text).filter(l=>l.trim()).join('\n');
  case 'join':return lines(text).map(l=>l.trim()).join('');
  case 'sort':return lines(text).sort().join('\n');
  case 'unique':return [...new Set(lines(text).sort())].join('\n');
  case 'filter':{const re=new RegExp(pattern);return lines(text).filter(l=>re.test(l)).join('\n');}
  case 'remove':return pattern?text.split(pattern).join(''):text;
  case 'cut':{const n=Number(field);if(!Number.isInteger(n)||n<1||!delimiter)throw Error('列号从 1 开始，分隔符不能为空');return lines(text).map(l=>l.split(delimiter)[n-1]??l).join('\n');}
  case 'newline':if(!pattern)throw Error('请输入要替换成换行的字符');return text.split(pattern).join('\n');
  default:throw Error('未知文本操作');
 }
}
// Based on cyeam_web smartdecode; preserve literal plus signs when decoding URI escapes.
const htmlEntities=new EntityDecoder({namedEntities:ALL_ENTITIES});
function printableUTF8(bytes){
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return text&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)?text:null;}catch{return null;}
}
function decodeOne(value){
 if(/%[0-9a-f]{2}/i.test(value)){try{return {value:decodeURIComponent(value),name:'URL 编码'};}catch{}}
 if(/\\u[0-9a-f]{4}/i.test(value))return {value:value.replace(/\\u([0-9a-f]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),name:'Unicode 转义'};
 if(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(value)){
  const decoded=htmlEntities.decode(value);if(decoded!==value)return {value:decoded,name:'HTML 实体'};
 }
 if(/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)&&value.length>=4){
  let normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  if(normalized.length%4!==1){try{
   normalized+='='.repeat((4-normalized.length%4)%4);
   const binary=atob(normalized),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),decoded=printableUTF8(bytes);
   if(decoded!==null)return {value:decoded,name:'Base64'};
  }catch{}}
 }
 if(/^[A-Z2-7]+=*$/i.test(value)&&value.length>=8){
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',clean=value.replace(/=/g,'').toUpperCase(),bytes=new Uint8Array(Math.floor(clean.length*5/8));
  let bits=0,buffer=0,index=0;
  for(const char of clean){buffer=(buffer<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8){bits-=8;bytes[index++]=(buffer>>bits)&255;buffer&=(1<<bits)-1;}}
  const decoded=printableUTF8(bytes);if(decoded!==null)return {value:decoded,name:'Base32'};
 }
 if(/^[0-9a-f]+$/i.test(value)&&value.length>=2&&value.length%2===0){
  const bytes=new Uint8Array(value.length/2);for(let i=0;i<value.length;i+=2)bytes[i/2]=parseInt(value.slice(i,i+2),16);
  const decoded=printableUTF8(bytes);if(decoded!==null)return {value:decoded,name:'Hex 十六进制'};
 }
 return null;
}
function smartDecode({text}){
 check(text);let current=text;const steps=[];
 for(let depth=0;depth<20;depth++){const next=decodeOne(current);if(!next||next.value===current)break;check(next.value);current=next.value;steps.push({name:next.name,value:next.value.slice(0,20000),truncated:next.value.length>20000});}
 return {result:current,layers:steps.map(step=>step.name),steps,limited:steps.length===20};
}
// Keep every byte of each HTML fragment so selecting all local/cloud chunks is lossless.
function noteCompare({left,right}){
 check(left);check(right);
 const tokens=html=>html.split(/(?<=<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>|<br>|<hr>|\n)/i);
 const parts=diffArrays(tokens(left),tokens(right),{timeout:1500,maxEditLength:10000});
 if(!parts)throw Error('差异过多，请使用整篇版本或缩小内容后重试');
 return parts.map(part=>({kind:part.added?'added':part.removed?'removed':'same',html:part.value.join('')}));
}
function compare({left,right}){
 check(left);check(right);
 const parts=diffLines(left,right,{timeout:1500,maxEditLength:10000});
 if(!parts)throw Error('差异过多，请缩小文本或先排序再对比');
 let a=1,b=1,added=0,removed=0;const rows=[];
 for(const part of parts){let ls=part.value.split('\n');if(ls.at(-1)==='')ls.pop();
  for(const line of ls){const kind=part.added?'added':part.removed?'removed':'same';rows.push({kind,a:part.added?'':a++,b:part.removed?'':b++,left:part.added?'':line,right:part.removed?'':line});}
  if(part.added)added+=ls.length;if(part.removed)removed+=ls.length;
 }
 return {rows,added,removed,addedText:parts.filter(p=>p.added).map(p=>p.value).join(''),removedText:parts.filter(p=>p.removed).map(p=>p.value).join('')};
}
function parseCSV(text,delimiter='auto'){
 check(text);text=text.replace(/^\uFEFF/,'');if(!text)return [];
 if(delimiter==='auto'){
  // Count candidate separators outside quoted fields, including quoted newlines.
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
 if(value!==''||row.length||closed) {row.push(value);rows.push(row);}
 return normalize(rows);
}
function normalize(rows){
 if(!Array.isArray(rows)||rows.some(r=>!Array.isArray(r)))throw Error('表格必须是二维数组');
 let width=0;for(const row of rows)width=Math.max(width,row.length);
 if(rows.length>200000||width>2048||rows.length*width>2000000)throw Error('表格最多 20 万行、2048 列、200 万个单元格');
 return rows.map(row=>Array.from({length:width},(_,i)=>row[i]==null?'':String(row[i])));
}
function objects(rows){
 if(!rows.length)return [];
 const headers=rows[0];if(new Set(headers).size!==headers.length||headers.some(h=>!h))throw Error('JSON/SQL 导出需要非空且唯一的列名，请先修改表头');
 return rows.slice(1).map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??''])));
}
function fromJSON(data){
 if(!Array.isArray(data))throw Error('JSON 必须是对象数组或二维数组');
 if(!data.length)return [];
 if(Array.isArray(data[0]))return normalize(data);
 if(data.some(v=>!v||typeof v!=='object'||Array.isArray(v)))throw Error('JSON 数组的元素必须全为对象');
 const keys=[...new Set(data.flatMap(Object.keys))];
 return normalize([keys,...data.map(v=>keys.map(k=>!Object.hasOwn(v,k)||v[k]==null?'':typeof v[k]==='object'?JSON.stringify(v[k]):String(v[k])))]);
}
const xmlEscape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const sqlString=s=>"'"+String(s).replaceAll("'","''")+"'";
function parseSQL(source){
 const statements=[];let start=0,quoted=false;
 for(let i=0;i<source.length;i++){if(source[i]==="'"){if(quoted&&source[i+1]==="'"){i++;continue;}quoted=!quoted;}if(source[i]===';'&&!quoted){statements.push(source.slice(start,i));start=i+1;}}
 if(source.slice(start).trim())statements.push(source.slice(start));
 let headers=null;const rows=[];
 for(const statement of statements){
  if(!statement.trim())continue;
  const match=statement.match(/^\s*INSERT\s+INTO\s+[^()]+\(([^)]+)\)\s*VALUES\s*([\s\S]+)$/i);
  if(!match)throw Error('SQL 导入支持 INSERT INTO table (列名...) VALUES (...)');
  const names=match[1].split(',').map(n=>n.trim().replace(/^[`"\[]|[`"\]]$/g,''));
  if(headers&&JSON.stringify(headers)!==JSON.stringify(names))throw Error('SQL 的列名必须一致');headers=names;
  const values=match[2];let row=[],value='',inString=false,inRow=false,wasString=false;
  const cell=()=>{const v=value.trim();row.push(wasString?value:/^null$/i.test(v)?'':v);value='';wasString=false;};
  for(let i=0;i<values.length;i++){
   const c=values[i];if(inString){if(c==="'"){if(values[i+1]==="'"){value+="'";i++;}else inString=false;}else value+=c;}
   else if(c==="'"){if(value.trim())throw Error('不支持 SQL 表达式');value='';inString=true;wasString=true;}
   else if(c==='('){if(inRow)throw Error('不支持 SQL 表达式');inRow=true;}
   else if(c===')'){cell();if(row.length!==headers.length)throw Error('SQL 列数不一致');rows.push(row);row=[];inRow=false;}
   else if(c===','&&inRow)cell();else if(inRow&&(!wasString||!c.match(/\s/)))value+=c;
  }
  if(inString||inRow)throw Error('SQL 字符串或括号未闭合');
 }
 return normalize(headers?[headers,...rows]:[]);
}
function columnName(n){let name='';for(n++;n;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;}
function columnIndex(name){let n=0;for(const c of name)n=n*26+c.charCodeAt(0)-64;return n-1;}
function xlsxWrite(rows){
 const sheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((r,y)=>'<row r="'+(y+1)+'">'+r.map((v,x)=>'<c r="'+columnName(x)+(y+1)+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEscape(v)+'</t></is></c>').join('')+'</row>').join('')+'</sheetData></worksheet>';
 const files={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':sheet
 };
 return zipSync(Object.fromEntries(Object.entries(files).map(([name,s])=>[name,strToU8(s)])),{level:3});
}
function xlsxRead(bytes){
 if(bytes.byteLength>MAX)throw Error('文件超过 20 MB');let size=0;
 const files=unzipSync(bytes,{filter:file=>{size+=file.originalSize;if(size>64*1024*1024)throw Error('Excel 解压后超过 64 MB');return /^(xl\/worksheets\/|xl\/sharedStrings|xl\/workbook|xl\/_rels\/workbook)/.test(file.name);}});
 const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false,trimValues:false,isArray:name=>['si','row','c','t','r','sheet','Relationship'].includes(name)});
 const parse=name=>{const xml=files[name]?strFromU8(files[name]):'';if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('不支持包含实体声明的 Excel XML');if(!xml)return {};if(XMLValidator.validate(xml)!==true)throw Error('Excel XML 格式错误');return parser.parse(xml);};
 const rich=node=>typeof node==='string'?node:node&&typeof node==='object'?(node.t?.map(rich).join('')??node.r?.map(rich).join('')??node['#text']??''):String(node??'');
 const strings=(parse('xl/sharedStrings.xml').sst?.si??[]).map(rich);
 const first=parse('xl/workbook.xml').workbook?.sheets?.sheet?.[0];
 const relations=parse('xl/_rels/workbook.xml.rels').Relationships?.Relationship??[];
 const relation=relations.find(r=>r['@_Id']===first?.['@_id']);
 let path=relation?.['@_Target'];path=path?(path.startsWith('/')?path.slice(1):'xl/'+path):Object.keys(files).find(n=>/^xl\/worksheets\/[^/]+\.xml$/.test(n));
 if(!path||!files[path])throw Error('Excel 中找不到工作表');
 const rows=[];for(const row of parse(path).worksheet?.sheetData?.row??[]){
  const y=Number(row['@_r']||rows.length+1)-1;if(y<0||y>200000)throw Error('工作表行号过大');while(rows.length<=y)rows.push([]);
  for(const cell of row.c??[]){const x=columnIndex(String(cell['@_r']||'A').replace(/\d+$/,''));if(x<0||x>=2048)throw Error('工作表列号过大');
   rows[y][x]=cell['@_t']==='s'?(strings[Number(cell.v)]??''):cell['@_t']==='inlineStr'?rich(cell.is):String(cell.v??'');
  }
 }
 return normalize(rows);
}
function parseJSONExact(text){
 const safe=text.replace(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,token=>{
  if(/^-?\d+$/.test(token)){const n=BigInt(token);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))return JSON.stringify(token);}
  return token;
 });return JSON.parse(safe);
}
function importTable({text='',format:kind='csv',delimiter='auto',bytes}){
 check(text);
 if(kind==='xlsx')return xlsxRead(new Uint8Array(bytes));
 if(kind==='json')return fromJSON(parseJSONExact(text));
 if(kind==='jsonl')return fromJSON(lines(text).filter(l=>l.trim()).map(l=>parseJSONExact(l)));
 if(kind==='sql')return parseSQL(text);
 if(kind==='markdown'){
  const rows=lines(text).filter(l=>l.trim()).map(l=>l.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(c=>c.trim().replaceAll('\\|','|').replaceAll('<br>','\n')));
  if(rows[1]?.every(c=>/^:?-+:?$/.test(c)))rows.splice(1,1);return normalize(rows);
 }
 return parseCSV(text,delimiter);
}
function exportTable({rows,format:kind='csv',table='data'}){
 rows=normalize(rows);
 if(kind==='xlsx')return {bytes:xlsxWrite(rows),extension:'xlsx'};
 if(kind==='json')return {text:JSON.stringify(objects(rows),null,2),extension:'json'};
 if(kind==='jsonl')return {text:objects(rows).map(o=>JSON.stringify(o)).join('\n'),extension:'jsonl'};
 if(kind==='sql'){
  objects(rows);const identifier=s=>'"'+s.replaceAll('"','""')+'"';
  return {text:rows.slice(1).map(r=>'INSERT INTO '+identifier(table)+' ('+rows[0].map(identifier).join(', ')+') VALUES ('+r.map(sqlString).join(', ')+');').join('\n'),extension:'sql'};
 }
 if(kind==='html')return {text:'<!doctype html><meta charset="utf-8"><table>'+rows.map((r,i)=>'<tr>'+r.map(c=>'<'+(i?'td':'th')+'>'+xmlEscape(c)+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</table>',extension:'html'};
 if(kind==='markdown')return {text:rows.map((r,i)=>'| '+r.map(c=>c.replaceAll('\\','\\\\').replaceAll('|','\\|').replaceAll('\n','<br>')).join(' | ')+' |'+(i===0?'\n| '+r.map(()=>'---').join(' | ')+' |':'')).join('\n'),extension:'md'};
 return {text:rows.map(r=>r.map(c=>/[",\r\n]/.test(c)?'"'+c.replaceAll('"','""')+'"':c).join(',')).join('\r\n'),extension:'csv'};
}
function tableOp({rows,op,column=0,pattern='',ascending=true}){
 rows=normalize(rows);if(!rows.length)return rows;
 if(op==='transpose')return normalize(rows[0].map((_,x)=>rows.map(r=>r[x])));
 if(op==='unique'){const seen=new Set();return [rows[0],...rows.slice(1).filter(r=>{const key=JSON.stringify(r);if(seen.has(key))return false;seen.add(key);return true;})];}
 if(op==='filter')return [rows[0],...rows.slice(1).filter(r=>String(r[column]??'').toLocaleLowerCase().includes(pattern.toLocaleLowerCase()))];
 if(op==='sort')return [rows[0],...rows.slice(1).sort((a,b)=>{
  const x=a[column]??'',y=b[column]??'';const numeric=x.trim()!==''&&y.trim()!==''&&Number.isFinite(Number(x))&&Number.isFinite(Number(y));
  return (numeric?Number(x)-Number(y):x.localeCompare(y))*(ascending?1:-1);
 })];
 throw Error('未知表格操作');
}
function stats({rows,column}){const values=rows.slice(1).map(r=>String(r[column]??'')).filter(v=>v.trim());const numbers=values.filter(v=>Number.isFinite(Number(v))).map(Number);const sum=numbers.reduce((a,b)=>a+b,0);return {count:values.length,numeric:numbers.length,sum,mean:numbers.length?sum/numbers.length:null};}
module.exports={smartDecode,noteCompare,stats,format,textOp,compare,parseCSV,importTable,exportTable,tableOp,normalize,objects,xlsxRead,xlsxWrite};
