// Browser notebook, homework and OneDrive. Native UI and desktop-only tools stay out.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {build}=require('esbuild');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist','cnote-web');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
(async()=>{
 const run=(command,args)=>cp.execFileSync(command,args,{cwd:root,stdio:'inherit'});
 run('cargo',['build','--manifest-path','web/core/Cargo.toml','--locked','--release','--target','wasm32-unknown-unknown']);
 const version=read('web/core/Cargo.toml').match(/wasm-bindgen = "=([^"]+)"/)[1];
 const installed=cp.execFileSync('wasm-bindgen',['--version'],{encoding:'utf8'}).trim();
 if(installed!==`wasm-bindgen ${version}`)throw Error(`需要 wasm-bindgen-cli ${version}，实际为 ${installed}`);
 fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
 run('wasm-bindgen',['web/core/target/wasm32-unknown-unknown/release/cnote_web.wasm','--target','web','--out-dir',path.join(out,'pkg'),'--out-name','cnote_web','--no-typescript']);
 const themes=JSON.parse(read('editor/themes.json'));
 const themeScript=read('editor/workspace.js').split('// Capture before tool editors')[0].replace('/* THEME_CATALOG */ []',JSON.stringify(themes));
 const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const navigation=`<nav id="web-navigation" aria-label="功能"><select id="web-workspace" aria-label="切换功能"><option value="0">CNote</option><option value="4">作业</option><option value="5">OneDrive</option></select><span id="web-notice" role="status"></span><button id="web-account-login" hidden>登录 OneDrive</button></nav><div id="web-download" hidden><a id="web-download-link" download>保存下载文件</a><button id="web-download-close" aria-label="关闭下载提示">×</button></div>`;
 const sidebar=`<aside id="web-sidebar" aria-label="笔记列表"><div class="sidebar-heading"><h1>CNote</h1><button id="close-sidebar" type="button" aria-label="关闭笔记列表">×</button></div><div class="sidebar-actions"><button id="new-note">新建笔记</button><button id="refresh">同步</button></div><button id="login">登录 OneDrive</button><span id="account"></span><label>主题 <select id="theme"><option value="system">跟随系统</option>${themes.map(t=>`<option value="${escape(t.id)}">${escape(t.label)}</option>`).join('')}</select></label><nav id="note-list" aria-label="笔记列表"></nav></aside><button id="sidebar-shade" type="button" aria-label="关闭笔记列表遮罩" hidden tabindex="-1"></button><button id="toggle-sidebar" title="切换笔记列表">☰</button>`;
 let html=read('editor/index.html')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: blob: data:; font-src data:; img-src data: blob: https:; frame-src https://login.microsoftonline.com; base-uri 'self'; form-action 'none'">`)
  .replace('<style>/* TOOL_STYLE */</style>','').replace('/* TRELLO_STYLE */',read('tools/trello.css')).replace('/* DRIVE_STYLE */',read('tools/drive.css'))
  .replace('/* ICONS */',read('editor/icons.css')).replace('/* STYLE */',read('editor/style.css')+'\n'+read('web/style.css'))
  .replace('<body>','<body>'+navigation+sidebar+'<script>window.cnoteWebQueue=[];window.ipc={postMessage:message=>cnoteWebQueue.push(message)};</script>')
  .replace('width=device-width,initial-scale=1','width=device-width,initial-scale=1,viewport-fit=cover')
  .replace('<header>','<header><button id="mobile-note-list" type="button" aria-controls="web-sidebar" aria-expanded="false">☰ 笔记</button><span id="mobile-brand">CNote</span>')
  .replace('</header>','<details id="mobile-more"><summary aria-label="更多操作">•••</summary><div><button id="mobile-export" type="button">导出 HTML</button><button id="mobile-print" type="button">打印</button></div></details></header>')
  .replace('<!-- TOOL_HTML -->','<section id="local-tools" hidden><section id="trello-tool" class="tool-page" hidden aria-label="作业"></section><section id="drive-tool" class="tool-page" hidden aria-label="OneDrive 文件管理"></section></section>')
  .replace(/<script id="tool-(?:worker|ace)-source"[^>]*>[\s\S]*?<\/script>/g,'')
  .replace('/* TABLE_TEXT */',read('tools/table-text.js')).replace('/* WORKSPACE */',themeScript)
  .replace('<script>/* TOOL_SCRIPT */</script>','').replace('/* TRELLO_SCRIPT */',read('tools/trello.js')).replace('/* DRIVE_SCRIPT */',read('tools/drive.js'))
  .replace('/* SCRIPT */',read('editor/editor.js')).replace('</head>','<title>CNote 笔记</title></head>')
  .replace('</body>','<script type="module" src="./adapter.js"></script></body>');
 if(/\/\* [A-Z_]+ \*\/|TOOL_HTML/.test(html))throw Error('Web 模板存在未替换占位符');
 fs.writeFileSync(path.join(out,'index.html'),html);
 await build({entryPoints:[path.join(root,'web/adapter.js')],bundle:true,minify:true,format:'esm',target:['safari17','chrome120','firefox121'],external:['./pkg/cnote_web.js'],outfile:path.join(out,'adapter.js'),legalComments:'eof'});
 await build({entryPoints:[path.join(root,'web/redirect.js')],bundle:true,minify:true,format:'esm',outfile:path.join(out,'auth.js'),legalComments:'eof'});
 fs.writeFileSync(path.join(out,'auth.html'),'<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; base-uri \'none\'"><title>Microsoft 登录</title></head><body><script type="module" src="./auth.js"></script></body></html>');
 fs.writeFileSync(path.join(out,'config.json'),JSON.stringify({clientId:process.env.CNOTE_WEB_CLIENT_ID||'e1f582c1-1568-4347-8c5b-1906164e637f',metadataEndpoint:null},null,2)+'\n');
 let commit='unknown',dirty=true;try{commit=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();dirty=Boolean(cp.execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());}catch{}
 fs.writeFileSync(path.join(out,'version.json'),JSON.stringify({version:process.env.CNOTE_WEB_VERSION||'development',commit,dirty},null,2)+'\n');
 fs.copyFileSync(path.join(root,'web/README.md'),path.join(out,'README.md'));
 fs.mkdirSync(path.join(out,'licenses'));
 for(const [name,file]of [['CNote','LICENSE'],['Bootstrap-Icons','assets/Bootstrap-Icons-LICENSE.txt'],['MSAL-Browser','node_modules/@azure/msal-browser/LICENSE'],['MSAL-Common','node_modules/@azure/msal-common/LICENSE'],['diff','node_modules/diff/LICENSE'],['fflate','node_modules/fflate/LICENSE']])fs.copyFileSync(path.join(root,file),path.join(out,'licenses',name+'.txt'));
 const files=[];const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else files.push(file);}};walk(out);
 fs.writeFileSync(path.join(out,'SHA256SUMS'),files.map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+path.relative(out,file)).join('\n')+'\n');
 console.log('CNote Web artifact: '+out);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
