// The Microsoft token is used only for this same-origin service request.
export function createConnection({fetch,getAccessToken}) {
 return async function connection(method='GET',revision='',record){
  const headers={Authorization:'Bearer '+await getAccessToken(),Accept:'application/json'};
  if(method!=='GET')headers[revision?'If-Match':'If-None-Match']=revision?'"'+revision+'"':'*';
  if(record)headers['Content-Type']='application/json';
  let response;
  try{response=await fetch('/api/cnote/trello-connection',{method,headers,body:record?JSON.stringify(record):undefined,credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)});}
  catch{throw Error('作业账号同步服务暂时无法连接，本机授权仍保留');}
  let result;try{result=await response.json();}catch{throw Error('作业账号同步服务尚不可用');}
  if(!response.ok){const messages={auth_required:'Trello 授权已失效，请重新授权',microsoft_auth_required:'微软登录已失效，请重新登录',connection_changed:'作业连接已在其他设备更新，请刷新后重试',board_unavailable:'当前授权无法访问这个作业看板'};throw Object.assign(Error(messages[result.code]||'作业账号同步服务暂不可用，本机授权仍保留'),{code:result.code});}
  return result;
 };
}
