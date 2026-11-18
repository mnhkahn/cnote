const sessionKey = 'cnote-web-trello';

function identifier(id) {
 if (!/^[a-f0-9]{24}$/i.test(id ?? '')) throw Error('无效的 Trello ID');
 return id;
}

function validateKey(key) {
 if (!/^[a-f0-9]{32}$/i.test(key ?? '')) throw Error('请输入有效的 Trello API Key');
 return key;
}

export function trelloAuthorization(key) {
 const url = new URL('https://trello.com/1/authorize');
 url.search = new URLSearchParams({
  key: validateKey(key), name: 'CNote Web', scope: 'read,write',
  expiration: 'never', response_type: 'token',
 });
 return url.href;
}

export function createTrello({fetch, storage, connection, getAccount}) {
 let credentials = null;
 try {
  credentials = JSON.parse(storage.getItem(sessionKey) || 'null');
 } catch {
  // An unavailable or invalid browser session can be connected again.
 }

 let scope=null,remoteLink=null,pendingConnection=false;
 function selectAccount(){
  const next=getAccount?.()?.homeAccountId||'';if(scope===next)return;
  scope=next;remoteLink=null;pendingConnection=false;
  if(!getAccount)return;
  credentials=null;
  try{
   const scoped=sessionKey+':'+scope;
   credentials=JSON.parse(storage.getItem(scoped)||'null');
   const old=storage.getItem(sessionKey),owner=storage.getItem(sessionKey+'-owner');
   if(!credentials&&old&&(!owner||owner===scope)){
    credentials=JSON.parse(old);storage.setItem(scoped,old);storage.setItem(sessionKey+'-owner',scope);storage.removeItem(sessionKey);
   }
  }catch{}
 }
 function persist(value){if(value)storage.setItem(getAccount?sessionKey+':'+scope:sessionKey,JSON.stringify(value));else storage.removeItem(getAccount?sessionKey+':'+scope:sessionKey);}
 async function saveRemote(record){
  const epoch=scope,result=await connection('PUT',remoteLink?.revision||'',record);
  if(scope!==epoch||(getAccount?.()?.homeAccountId||'')!==epoch)throw Error('微软账号已切换，请重试');
  remoteLink=result;credentials=result.connection.credentials;pendingConnection=false;persist(null);return result;
 }

 async function get(path, params, auth) {
  const url = new URL('https://api.trello.com/1' + path);
  url.search = new URLSearchParams(params);
  let response;
  try {
   response = await fetch(url.href, {
    headers: {Authorization: `OAuth oauth_consumer_key="${auth.key}", oauth_token="${auth.token}"`},
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
   });
  } catch {
   throw Error('无法连接 Trello，请检查网络后重试');
  }
  if (response.status === 401) {
   throw Object.assign(Error('Trello 授权已失效，请重新关联'), {code: 'auth_required'});
  }
  if (!response.ok) throw Error(`Trello 请求失败（${response.status}），请稍后重试`);
  return response.json();
 }

 return {
  async request({op, id, key, token, account_id, member_id}) {
   selectAccount();
   if(account_id!==undefined&&getAccount&&account_id!==scope)throw Error('微软账号已切换，请重试');
   switch (op) {
    case 'status': {
     if(!connection||!scope)return {connected:!!credentials,key:credentials?.key};
     const epoch=scope;
     try{
      const remote=await connection('GET');if(scope!==epoch||(getAccount?.()?.homeAccountId||'')!==epoch)throw Error('微软账号已切换，请重试');
      if(typeof remote.connected!=='boolean')throw Error('作业连接响应格式无效');
      if(remote.connected){remoteLink=remote;if(!pendingConnection){credentials=remote.connection.credentials;persist(null);}}
      else if(remoteLink){remoteLink=null;if(!pendingConnection){credentials=null;persist(null);}}
      return {connected:!!credentials,key:credentials?.key,account_linking:true,account_id:scope,linked:!!remote.connected&&!pendingConnection,cloud_available:true,board:remote.connection?.board_id};
     }catch(error){return {connected:!!credentials,key:credentials?.key,account_linking:true,account_id:scope,cloud_available:false,connection_error:error.message};}
    }
    case 'link_status': {
     if(!connection||!scope||!credentials)throw Error('请先登录微软并授权 Trello');
     const member=await get('/members/me',{fields:'id,fullName,username'},credentials);
     const boards=await get('/members/me/boards',{filter:'open',fields:'name,closed'},credentials);
     return {member,boards,account_id:scope,account_name:getAccount()?.name||scope};
    }
    case 'link_account': {
     if(!connection||!scope||!credentials)throw Error('请先登录微软并授权 Trello');
     const member=await get('/members/me',{fields:'id,fullName'},credentials);
     if(member.id!==member_id)throw Error('Trello 账号已变化，请重新确认');
     const board=await get('/boards/'+identifier(id),{fields:'id,name,closed'},credentials);
     if(board.closed)throw Error('请选择未归档的作业看板');
     await saveRemote({credentials,member_id:member.id,member_name:member.fullName||'',board_id:id,board_name:board.name||''});
     return {linked:true,board:id};
    }
    case 'link_board': {
     if(!remoteLink?.connected)throw Error('请先保存作业连接到账号');
     const board=await get('/boards/'+identifier(id),{fields:'id,name,closed'},credentials);if(board.closed)throw Error('请选择未归档的作业看板');
     await saveRemote({...remoteLink.connection,board_id:id,board_name:board.name||''});return {saved:true};
    }
    case 'connect': {
     const next = {key: validateKey(key), token};
     if (!/^[a-z0-9]{32,256}$/i.test(token ?? '')) throw Error('请输入有效的 Trello Token');
     await get('/members/me', {fields: 'id'}, next);
     persist(next);
     credentials = next;pendingConnection=true;
     return {};
    }
    case 'disconnect':
     if(connection&&scope)await connection('DELETE',remoteLink?.revision||'');
     remoteLink=null;pendingConnection=false;persist(null);
     credentials = null;
     return {};
   }

   const auth = credentials;
   if (!auth) throw Object.assign(Error('请先关联 Trello'), {code: 'auth_required'});
   const read = (path, params) => get(path, params, auth);

   switch (op) {
    case 'boards':
     return {boards: await read('/members/me/boards', {filter: 'open', fields: 'name,closed,url'})};
    case 'board': {
     const path = '/boards/' + identifier(id);
     const [lists, cards] = await Promise.all([
      read(path + '/lists', {filter: 'open', fields: 'name,closed,pos'}),
      read(path + '/cards', {
       filter: 'open',
       fields: 'name,desc,due,dueComplete,idList,closed,url,dateLastActivity,dateCompleted',
      }),
     ]);
     return {lists, cards};
    }
    case 'card': {
     const path = '/cards/' + identifier(id);
     const card = await read(path, {fields: 'all', checklists: 'all', members: 'true'});
     const [attachments, actions] = await Promise.allSettled([
      read(path + '/attachments', {fields: 'name,date'}),
      read(path + '/actions', {filter: 'all', limit: '1000'}),
     ]);
     return {
      card,
      attachments: attachments.value,
      actions: actions.value,
      partial: attachments.status === 'rejected' || actions.status === 'rejected',
     };
    }
    default:
     throw Error('Web 作业仅支持查看');
   }
  },
 };
}
