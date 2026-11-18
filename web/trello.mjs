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
  key: validateKey(key), name: 'CNote Web', scope: 'read',
  expiration: '30days', response_type: 'token',
 });
 return url.href;
}

export function createTrello({fetch, storage}) {
 let credentials = null;
 try {
  credentials = JSON.parse(storage.getItem(sessionKey) || 'null');
 } catch {
  // An unavailable or invalid browser session can be connected again.
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
  async request({op, id, key, token}) {
   switch (op) {
    case 'status':
     return {connected: !!credentials, key: credentials?.key};
    case 'connect': {
     const next = {key: validateKey(key), token};
     if (!/^[a-z0-9]{32,256}$/i.test(token ?? '')) throw Error('请输入有效的 Trello Token');
     await get('/members/me', {fields: 'id'}, next);
     storage.setItem(sessionKey, JSON.stringify(next));
     credentials = next;
     return {};
    }
    case 'disconnect':
     storage.removeItem(sessionKey);
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
