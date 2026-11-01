// Debug-only native save regression fixture: real WebKit UI and Rust IPC,
// deterministic image bytes, no user credentials or Trello network requests.
(() => {
 const card={id:'111111111111111111111111',name:'图片下载本地验证',desc:'验证保存面板、取消与原图落盘',idList:'todo',due:new Date().toISOString(),dueComplete:false};
 const attachment={id:'222222222222222222222222',name:'cnote-image-save-test.png',mimeType:'image/png',isUpload:true,date:new Date().toISOString(),url:'https://trello.com/'};
 window.cnoteTrelloNativeFixture=message=>{
  const data=message.op==='status'?{connected:true}:message.op==='boards'?{boards:[{id:'native-save-test',name:'本地保存验证'}]}:message.op==='board'?{lists:[{id:'todo',name:'待完成'}],cards:[card]}:message.op==='card'?{card,attachments:[attachment],actions:[]}:message.op==='attachment'?{mime:'image/png',base64:'__PNG__'}:{};
  setTimeout(()=>window.cnoteTrello.receive({request:message.request,data}),0);
 };
 window.cnoteTools.setTrelloBoard('native-save-test');
})();
