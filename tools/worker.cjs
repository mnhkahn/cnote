'use strict';
const core=require('./core.cjs');
self.onmessage=event=>{
 const {id,task,data}=event.data;
 try {
  if(!Object.hasOwn(core,task)||typeof core[task]!=='function')throw Error('未知工具操作');
  const result=core[task](data);
  self.postMessage({id,result},result?.bytes?[result.bytes.buffer]:[]);
 }catch(error){self.postMessage({id,error:String(error.message||error)});}
};
