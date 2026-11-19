// Build the browser-callable Rust core and export reusable editor resources.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
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
 let commit='unknown',dirty=true;try{commit=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();dirty=Boolean(cp.execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());}catch{}
 fs.writeFileSync(path.join(out,'version.json'),JSON.stringify({format:'cnote-wasm-core-v1',version:process.env.CNOTE_WEB_VERSION||'development',commit,dirty},null,2)+'\n');
 const resources=['editor/index.html','editor/icons.css','editor/style.css','editor/themes.json','editor/workspace.js','editor/editor.js','tools/table-text.js','tools/trello.css','tools/trello.js','tools/drive.css','tools/drive.js'];
 for(const name of resources){
  const target=path.join(out,'shared',name);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(root,name),target);
 }
 fs.mkdirSync(path.join(out,'licenses'));
 for(const [name,file] of [['CNote','LICENSE'],['Bootstrap-Icons','assets/Bootstrap-Icons-LICENSE.txt']]){
  fs.copyFileSync(path.join(root,file),path.join(out,'licenses',name+'.txt'));
 }
 const files=[];const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else files.push(file);}};walk(out);
 fs.writeFileSync(path.join(out,'SHA256SUMS'),files.map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+path.relative(out,file)).join('\n')+'\n');
 console.log('CNote WASM core package: '+out);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
