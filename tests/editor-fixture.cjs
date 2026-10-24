const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
module.exports=function html(){let source=fs.readFileSync(path.join(root,'editor/index.html'),'utf8');
 const files={'/* ICONS */':'editor/icons.css','/* STYLE */':'editor/style.css','/* SCRIPT */':'editor/editor.js','/* TOOL_STYLE */':'tools/style.css','<!-- TOOL_HTML -->':'tools/index.html','/* TOOL_WORKER */':'tools/vendor/worker.b64','/* TOOL_ACE */':'tools/vendor/ace.b64','/* WORKSPACE */':'editor/workspace.js','/* TOOL_SCRIPT */':'tools/tools.js'};
 for(const [placeholder,file]of Object.entries(files))source=source.replace(placeholder,fs.readFileSync(path.join(root,file),'utf8'));
 return source.replace('/* THEME_CATALOG */ []',fs.readFileSync(path.join(root,'editor/themes.json'),'utf8'));
};
