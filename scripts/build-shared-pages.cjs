// Compile the existing desktop editor and feature pages, reusing the canonical sources.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.env.CNOTE_SHARED_ASSETS||path.join(root,'dist/shared-pages'));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const nav=`<nav id="mobile-tabs" aria-label="功能"><button data-workspace="0" aria-selected="true">笔记</button><button data-workspace="4" aria-selected="false">作业</button><button data-workspace="5" aria-selected="false">OneDrive</button><button id="mobile-update" aria-label="检查更新">⋮</button></nav><aside id="mobile-notes"><div class="mobile-actions"><button id="mobile-note-toggle">笔记列表</button><button id="mobile-new">新建</button><button id="mobile-sync">同步</button><button id="mobile-image">插图</button><button id="mobile-delete">删除</button><button id="mobile-login">登录 OneDrive</button></div><input id="mobile-search" type="search" placeholder="搜索笔记"><div id="mobile-note-list"></div></aside>`;
const pages='<section id="local-tools" hidden><section id="trello-tool" class="tool-page" hidden aria-label="作业"></section><section id="drive-tool" class="tool-page" hidden aria-label="OneDrive 文件管理"></section></section>';
let html=read('editor/index.html').replace('width=device-width,initial-scale=1','width=device-width,initial-scale=1,interactive-widget=resizes-content')
 .replace('<body>','<body>'+nav+'<script>'+read('shared/pages/mobile.js')+'</script>')
 .replace('/* ICONS */',read('editor/icons.css')).replace('/* STYLE */',read('editor/style.css'))
 .replace('/* TOOL_STYLE */','').replace('/* TRELLO_STYLE */',read('tools/trello.css')).replace('/* DRIVE_STYLE */',read('tools/drive.css')+'\n'+read('shared/pages/mobile.css'))
 .replace('<!-- TOOL_HTML -->',pages).replace('/* TOOL_WORKER */',read('tools/vendor/worker.b64')).replace(/<script id="tool-ace-source"[^>]*>[\s\S]*?<\/script>/,'')
 .replace('/* TABLE_TEXT */',read('tools/table-text.js')).replace('/* WORKSPACE */',read('editor/workspace.js').split('// Capture before tool editors')[0].replace('/* THEME_CATALOG */ []',read('editor/themes.json')))
 .replace('/* TOOL_SCRIPT */','').replace('/* TRELLO_SCRIPT */',read('tools/trello.js')).replace('/* DRIVE_SCRIPT */',read('tools/drive.js')).replace('/* SCRIPT */',read('editor/editor.js'));
if(/\/\* [A-Z_]+ \*\/|TOOL_HTML/.test(html))throw Error('Unresolved template placeholder');
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'index.html'),html);
const features=html.replace('<body>','<body class="feature-only">');
fs.writeFileSync(path.join(out,'features.html'),features);
fs.writeFileSync(path.join(out,'LICENSES.txt'),read('LICENSE')+'\n'+read('assets/Bootstrap-Icons-LICENSE.txt')+'\n'+read('tools/vendor/LICENSES.txt'));
fs.writeFileSync(path.join(out,'pages.json'),JSON.stringify({protocol:1,features:['notes','trello','onedrive'],sha256:crypto.createHash('sha256').update(html).digest('hex'),featuresSha256:crypto.createHash('sha256').update(features).digest('hex')},null,2)+'\n');
console.log('Shared pages: '+out);
