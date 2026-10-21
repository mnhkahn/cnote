const {test}=require('node:test'),assert=require('node:assert/strict');
const c=require('../tools/core.cjs');
test('JSON formatting and table import preserve integers beyond IEEE754',()=>{
 const value='{"id":9007199254740993123,"nested":[1,true,null,"a b"]}';
 assert(c.format(value).includes('9007199254740993123'));
 assert.equal(c.textOp({text:value,op:'compact'}),value);
 assert.deepEqual(c.importTable({format:'json',text:'[{"id":9007199254740993123}]'}),[['id'],['9007199254740993123']]);
 assert.throws(()=>c.format('{"broken":}'));
});
test('text transforms match line cleaning, regex, literal deletion and one-based cut',()=>{
 assert.equal(c.textOp({text:'b\n\na\nb',op:'trim-empty'}),'b\na\nb');
 assert.equal(c.textOp({text:'b\n\na\nb',op:'unique'}),'\na\nb');
 assert.equal(c.textOp({text:'ok=1\nfail=2',op:'filter',pattern:'^ok'}),'ok=1');
 assert.equal(c.textOp({text:'a.b.a',op:'remove',pattern:'.'}),'aba');
 assert.equal(c.textOp({text:'a,b\nc,d',op:'cut',delimiter:',',field:2}),'b\nd');
 assert.throws(()=>c.textOp({text:'a',op:'filter',pattern:'['}));
 assert.throws(()=>c.textOp({text:'a',op:'cut',delimiter:',',field:0}));
});
test('format XML mixed content and SQL without changing quoted values',()=>{
 const xml=c.format('<root><p>Hello <b>world</b> !</p><empty/></root>','xml');
 assert(xml.includes('Hello'));assert(xml.includes('world'));
 assert.throws(()=>c.format('<root><bad></root>','xml'));
 assert(c.format("select 'from, select' as x from t where id = 1",'sql').includes("'from, select'"));
});
test('diff extracts exact added/deleted lines and final-newline changes',()=>{
 const d=c.compare({left:'共同\n旧\n',right:'共同\n新\n'});
 assert.equal(d.added,1);assert.equal(d.removed,1);assert.equal(d.addedText,'新\n');assert.equal(d.removedText,'旧\n');
 assert(c.compare({left:'x',right:'x\n'}).rows.some(r=>r.kind!=='same'));
});
test('CSV handles quoted delimiters, escaped quotes, BOM, CRLF and embedded newlines',()=>{
 const rows=[['name','value'],['中文','001'],['quoted','a,"b"\nc'],['empty','']];
 const csv=c.exportTable({rows}).text;
 assert.deepEqual(c.parseCSV('\uFEFF'+csv),rows);
 assert.deepEqual(c.parseCSV('x\ty\r\na\tb\r\n'),[['x','y'],['a','b']]);
 assert.deepEqual(c.parseCSV('a;b\n1;2'),[['a','b'],['1','2']]);
 assert.throws(()=>c.parseCSV('a,b\n"unclosed,c'));
});
test('table imports union object keys and safely handles prototype-looking headers',()=>{
 const rows=c.importTable({format:'json',text:'[{"__proto__":"safe","b":1},{"b":2,"c":3}]'});
 assert.deepEqual(rows,[['__proto__','b','c'],['safe','1',''],['','2','3']]);
 assert.equal(c.objects(rows)[0].__proto__,'safe');
 assert.throws(()=>c.exportTable({rows:[['same','same'],['a','b']],format:'json'}));
});
test('table sorting, filtering, deduplication and transpose retain all values',()=>{
 const rows=[['name','n'],['x','10'],['y','2'],['x','10']];
 assert.deepEqual(c.tableOp({rows,op:'sort',column:1})[1],['y','2']);
 assert.equal(c.tableOp({rows,op:'unique'}).length,3);
 assert.equal(c.tableOp({rows,op:'filter',column:0,pattern:'x'}).length,3);
 assert.deepEqual(c.tableOp({rows,op:'transpose'})[0],['name','x','y','x']);
 assert.deepEqual(c.stats({rows,column:1}),{count:3,numeric:3,sum:22,mean:22/3});
});
test('JSON, JSONL, Markdown and SQL export/import round trips',()=>{
 const rows=[['name','value'],["O'Reilly",'001'],['汉字','with,comma']];
 for(const format of ['json','jsonl','markdown','sql']){
  const text=c.exportTable({rows,format}).text;
  assert.deepEqual(c.importTable({text,format}),rows,format);
 }
 assert(c.exportTable({rows:[['x'],['<script>alert(1)</script>']],format:'html'}).text.includes('&lt;script&gt;'));
});
test('Excel round trip keeps Unicode, quoted strings, empty cells and formula text inert',()=>{
 const rows=[['列名','value','blank'],['中文','001',''],['=SUM(A1:A2)','a"b\nc',''],['emoji','😀','']];
 const xlsx=c.xlsxWrite(rows);assert.equal(xlsx[0],0x50);assert.equal(xlsx[1],0x4b);
 assert.deepEqual(c.xlsxRead(xlsx),rows);
});
test('table rejects dimensions that would create excessive DOM or memory usage',()=>{
 assert.throws(()=>c.normalize([Array(2049).fill('x')]));
});
