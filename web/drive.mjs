import {safeName,uniqueName,readBytes} from './downloads.mjs';
const fields='id,name,size,folder,file,eTag,lastModifiedDateTime,parentReference';
const item=id=>'/me/drive/items/'+encodeURIComponent(id);
const parent=m=>m.parent?item(m.parent):'/me/drive/root';
function filename(value){if(typeof value!=='string'||!value.trim()||/[\\/:*?"<>|\x00-\x1f]/.test(value)||value==='.'||value==='..'||/[. ]$/.test(value)||new TextEncoder().encode(value).length>255)throw Error('文件名无效');return value;}
export function createDrive({graph,fetch,downloads}){
 async function checked(response){if(!response.ok)throw Error(response.status===412?'文件已变化，请刷新后重试':`OneDrive 请求失败（HTTP ${response.status}）`);return response;}
 const json=async(path,options)=>{const r=await checked(await graph(path,options));return r.status===204?{}:r.json();};
 async function pages(path){const items=[];while(path){const p=await json(path);items.push(...(p.value||[]));path=p['@odata.nextLink'];}return items;}
 async function content(id){
  const meta=await json(item(id)+'?$select='+fields+',@microsoft.graph.downloadUrl');
  const url=new URL(meta['@microsoft.graph.downloadUrl']);if(url.protocol!=='https:'||url.username||url.password)throw Error('文件下载地址无效');
  const response=await fetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(120000)});await checked(response);return {meta,response};
 }
 async function collect(meta,files,prefix='',depth=0){
  if(depth>40)throw Error('目录层级过深');
  const name=uniqueName(files,prefix+safeName(meta.name));
  if(meta.folder){for(const child of await pages(item(meta.id)+'/children?$select='+fields+'&$top=200'))await collect(child,files,name+'/',depth+1);return;}
  const {response}=await content(meta.id);const data=await readBytes(response,200*1024*1024-Object.values(files).reduce((n,v)=>n+v.length,0));
  if(Object.values(files).reduce((n,v)=>n+v.length,0)+data.length>200*1024*1024)throw Error('本次下载超过 200 MB，请分批下载');files[name]=data;
 }
 return {content,async request(m){
  if(m.op==='list'||m.op==='search'){
   const folder=await json(parent(m)+'?$select='+fields);
   const path=m.op==='search'?parent(m)+"/search(q='"+encodeURIComponent(String(m.query).replaceAll("'","''")).replaceAll("'",'%27')+"')":parent(m)+'/children';
   return {folder,items:await pages(path+'?$select='+fields+'&$top=200')};
  }
  if(m.op==='mkdir'){await json(parent(m)+'/children',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:filename(m.name),folder:{},'@microsoft.graph.conflictBehavior':'fail'})});return {changed:true};}
  if(m.op==='upload'){
   const binary=atob(m.data||'');if(binary.length>20*1024*1024)throw Error('上传文件超过 20 MB');
   await checked(await graph(parent(m)+':/'+encodeURIComponent(filename(m.name))+':/content?@microsoft.graph.conflictBehavior=fail',{method:'PUT',headers:{'Content-Type':'application/octet-stream','If-None-Match':'*'},body:Uint8Array.from(binary,c=>c.charCodeAt(0))}));return {changed:true};
  }
  if(m.op==='read'){
   const {meta,response}=await content(m.id);const bytes=await readBytes(response,2*1024*1024);if(bytes.length>2*1024*1024)throw Error('文本超过 2 MB');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw Error('此文件不是文本');
   const after=await json(item(m.id)+'?$select='+fields);if(meta.eTag!==after.eTag)throw Error('文件已变化，请重新打开');return {item:after,text};
  }
  if(['rename','move','delete','save'].includes(m.op)){
   if(!m.etag)throw Error('缺少文件版本，请刷新后重试');const headers={'If-Match':m.etag,'Content-Type':'application/json'};
   if(m.op==='delete')await checked(await graph(item(m.id),{method:'DELETE',headers}));
   else if(m.op==='save'){if(new TextEncoder().encode(m.text||'').length>2*1024*1024)throw Error('文本超过 2 MB');await checked(await graph(item(m.id)+'/content',{method:'PUT',headers:{...headers,'Content-Type':'text/plain;charset=utf-8'},body:m.text}));}
   else {let body;if(m.op==='rename')body={name:filename(m.name),'@microsoft.graph.conflictBehavior':'fail'};else{const path=String(m.destination||'/').replace(/^\/+|\/+$/g,'');const dest=await json(path?'/me/drive/root:/'+path.split('/').map(encodeURIComponent).join('/'):'/me/drive/root');if(!dest.folder)throw Error('目标不是文件夹');body={parentReference:{id:dest.id}};}await json(item(m.id),{method:'PATCH',headers,body:JSON.stringify(body)});}
   return {changed:true};
  }
  if(m.op==='download'){
   if(!Array.isArray(m.ids)||!m.ids.length)throw Error('请选择文件');const files={};
   for(const id of m.ids)await collect(await json(item(id)+'?$select='+fields),files);
   const names=Object.keys(files);if(names.length===1&&!names[0].includes('/'))downloads.save(names[0],new Blob([files[names[0]]]));else downloads.zip('CNote-OneDrive.zip',files);
   return {directory:'浏览器下载',count:names.length};
  }
  throw Error('不支持的 OneDrive 操作');
 }};
}
