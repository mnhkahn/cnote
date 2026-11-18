const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('shared/pages/mobile.js','utf8');
function page(){
 const shown=[],messages=[],elements=new Map();
 const document={body:{classList:{toggle(){},add(){}}},querySelectorAll:()=>[],addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id);}};
 const window={cnoteHost:{postMessage:raw=>messages.push(JSON.parse(raw))},cnoteTrello:{show(){shown.push(window.cnoteTools.state.trelloBoard||'');},hide(){}},cnoteDrive:{show(){}},cnote:{receive(e){window.cnoteTools.receive(e);}}};
 vm.runInNewContext(source,{window,document,Map,JSON,ipc:{postMessage:raw=>window.cnoteHost.postMessage(raw)}});
 return {window,shown,messages,restore(state){window.cnoteMobile.receive({type:'tool_state',state});}};
}
test('opening Trello before stored state arrives restores the previous board',()=>{
 const p=page();p.window.cnoteMobile.featureMode(4);assert.deepEqual(p.shown,[]);
 p.restore({trelloBoard:'previous-board'});assert.deepEqual(p.shown,['previous-board']);
});
test('a board selected in one page is restored in a new page',()=>{
 const original=page();original.restore({trelloBoard:'older-board',otherSetting:'kept'});
 original.window.cnoteTools.setTrelloBoard('last-board');
 const save=original.messages.find(message=>message.type==='tool_save');assert.equal(save.state.otherSetting,'kept');
 const reopened=page();reopened.restore(save.state);reopened.window.cnoteMobile.featureMode(4);
 assert.deepEqual(reopened.shown,['last-board']);
});
test('late state does not reopen Trello after switching to OneDrive',()=>{
 const p=page();p.window.cnoteMobile.featureMode(4);p.window.cnoteMobile.featureMode(5);
 p.restore({trelloBoard:'last-board'});assert.deepEqual(p.shown,[]);
 p.window.cnoteMobile.featureMode(4);assert.deepEqual(p.shown,['last-board']);
});
