// Maintenance-only bundling. Rust builds use these checked-in offline assets.
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),check=process.argv.includes('--check');
function asset(name,data){const file=path.join(root,'tools/vendor',name),bytes=Buffer.from(data);if(check){if(!fs.existsSync(file)||!fs.readFileSync(file).equals(bytes))throw Error(name+' is stale; run npm run build:tools');}else fs.writeFileSync(file,bytes);}
const output=esbuild.buildSync({entryPoints:[path.join(root,'tools/worker.cjs')],bundle:true,platform:'browser',format:'iife',target:'es2020',minify:true,charset:'ascii',legalComments:'none',write:false}).outputFiles[0].contents;
asset('worker.js',output);asset('worker.b64',Buffer.from(output).toString('base64'));
const aceRoot=process.env.CNOTE_ACE_SOURCE,names=['ace.min.js','theme-github.min.js','mode-json.min.js','mode-xml.min.js','mode-sql.min.js'];
let ace=fs.readFileSync(path.join(root,'tools/vendor/ace.js'));
if(aceRoot){ace=Buffer.from(names.map(n=>fs.readFileSync(path.join(aceRoot,n),'utf8')).join('\n'));asset('ace.js',ace);}
asset('ace.b64',ace.toString('base64'));
const packages=['diff','fflate','fast-xml-parser','sql-formatter','xml-formatter'],seen=new Set();
let notices='Offline tool dependencies\n\n';
while(packages.length){const name=packages.pop();if(seen.has(name))continue;seen.add(name);const dir=path.join(root,'node_modules',name);if(!fs.existsSync(dir))throw Error('Missing dependency '+name);const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));packages.push(...Object.keys(pkg.dependencies||{}));const license=fs.readdirSync(dir).find(n=>/^licen[sc]e(?:\.md|\.txt)?$/i.test(n));let text;
 if(name==='@nodable/entities')text=fs.readFileSync(path.join(root,'tools/vendor/licenses/entities-MIT.txt'),'utf8');
 else if(license)text=fs.readFileSync(path.join(dir,license),'utf8');
 else {const readme=fs.readFileSync(path.join(dir,'README.md'),'utf8');const at=readme.lastIndexOf('License');text=at>=0?readme.slice(at):'License: '+pkg.license;}
 notices+=`\n${name} ${pkg.version} (${pkg.license})\n`+text+'\n';}
notices+='\nAce 1.32.6, BSD-3-Clause; reused from cyeam_web.\n'+fs.readFileSync(path.join(root,'tools/vendor/Ace-LICENSE.txt'),'utf8');
asset('LICENSES.txt',notices);console.log(check?'Offline tool assets verified.':'Offline tool assets rebuilt.');
