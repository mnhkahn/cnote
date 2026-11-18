import {createDownloads} from './downloads.mjs';
import {createDrive} from './drive.mjs';
import {createTrello, trelloAuthorization} from './trello.mjs';

export async function createFeatures({store,graph,fetch,compareNote,onShow,getAccount,storage=sessionStorage}){
 let workspace=0,state=await store.get('tools')||{},saving=Promise.resolve();
 const persist=()=>{const value=structuredClone(state);saving=saving.catch(()=>{}).then(()=>store.set('tools',value));return saving;};
 const downloads=createDownloads(document,URL);
 const trello=createTrello({fetch,storage});
 function drive(){const account=getAccount();const guard=()=>{if(getAccount()!==account)throw Error('OneDrive 账号已变化，请重试');};return createDrive({graph:(...args)=>{guard();return graph(...args);},fetch,downloads:{save(...args){guard();return downloads.save(...args);},zip(...args){guard();return downloads.zip(...args);}}});}
 function show(index){
  if(![0,4,5].includes(index))return;
  if(index!==4)window.cnoteTrello.hide();
  workspace=index;state.workspace=index;
  document.body.classList.toggle('web-tools',index!==0);
  document.getElementById('local-tools').hidden=index===0;
  document.getElementById('trello-tool').hidden=index!==4;
  document.getElementById('drive-tool').hidden=index!==5;
  document.getElementById('web-workspace').value=String(index);
  if(index===4)window.cnoteTrello.show();
  if(index===5)window.cnoteDrive.show();
  onShow(index);persist().catch(error=>notice(error.message));
 }
 const notice=message=>{document.getElementById('web-notice').textContent=message;};
 window.cnotePlatform={web:true,mobile:false};
 window.cnoteTools={get workspace(){return workspace;},get state(){return state;},show,flush(){return saving;},barrier(next){saving.then(next).catch(error=>notice(error.message));},compareNote,trelloAuthorization,
  setTrelloBoard(id){state.trelloBoard=id;persist().catch(error=>notice(error.message));}
 };
 document.getElementById('drive-download').textContent='下载';document.getElementById('drive-open').textContent='下载文件';
 const lastWorkspace=[0,4,5].includes(state.workspace)?state.workspace:0;
 return {show,initialWorkspace:lastWorkspace,content:(...args)=>drive().content(...args),account(account){window.cnoteDrive.account(!!account,account?.name||'');document.getElementById('web-account-login').hidden=workspace!==5||!!account;},
  async dispatch(m){
   const isTrello=m.type==='trello';
   const target=isTrello?window.cnoteTrello:window.cnoteDrive;
   try{const data=await (isTrello?trello.request(m):drive().request(m));target.receive({request:m.request,data});}
   catch(error){target.receive({request:m.request,error:error.message,code:error.code});}
  }
 };
}
