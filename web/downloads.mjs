import {zipSync} from 'fflate';
export function safeName(value){
 const cleaned=String(value||'文件').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^\.+|[. ]+$/g,'');let name='';
 for(const char of cleaned){if(new TextEncoder().encode(name+char).length>160)break;name+=char;}return name||'文件';
}
export async function readBytes(response,limit){
 if(Number(response.headers?.get('content-length')||0)>limit)throw Error('文件过大，请分批下载');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('文件过大，请分批下载');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function uniqueName(files,name){const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';let value=name,index=1;while(Object.hasOwn(files,value))value=`${stem} (${index++})${ext}`;return value;}
export function createDownloads(document,URL){
 let lastURL;
 return {
  save(name,blob){
   if(lastURL)URL.revokeObjectURL(lastURL);lastURL=URL.createObjectURL(blob);
   const panel=document.getElementById('web-download'),link=document.getElementById('web-download-link');
   link.href=lastURL;link.download=safeName(name);link.textContent='保存 '+safeName(name);panel.hidden=false;
   // A persistent link also permits an explicit tap when iOS requires a fresh gesture.
   link.click();return {saved:true};
  },
  zip(name,files){return this.save(name,new Blob([zipSync(files,{level:0})],{type:'application/zip'}));}
 };
}
