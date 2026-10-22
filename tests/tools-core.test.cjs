const {test}=require('node:test'),assert=require('node:assert/strict');
const c=require('../tools/core.cjs');
test('JSON formatting and table import preserve integers beyond IEEE754',()=>{
 const value='{"id":9007199254740993123,"nested":[1,true,null,"a b"]}';
 assert(c.format(value).includes('9007199254740993123'));
 assert.equal(c.textOp({text:value,op:'compact'}),value);
 assert.deepEqual(c.importTable({format:'json',text:'[{"id":9007199254740993123}]'}),[['id'],['9007199254740993123']]);
 assert.throws(()=>c.format('{"broken":}'));
});
test('AI table copy restores header, records, Chinese text and split URLs', () => {
    const url = 'https://wwj.shanxi.gov.cn/wwzy/wwlb/bkydww/qgzdwwbhdw/zh/202109/t20210908_1981994';
    const input = `序号    建筑名称    年代    公布批次    类别    所在市    所在县    国保编号
    简注    数据来源URL
    1    云冈石窟    北魏    1    石窟寺及石刻    大同市    云冈区    1    中国三大石
    窟之一，北魏皇家石窟群，世界文化遗产；第八批吴官屯、鲁班窑石窟并入
    ${url}
    .shtml
    2    羊头山石窟    北魏至唐    6    石窟寺及石刻    晋城市    高平市    2    北魏
    至唐摩崖造像石窟群
    ${url}
    .shtml`;
    const expected = `序号    建筑名称    年代    公布批次    类别    所在市    所在县    国保编号    简注    数据来源URL
1    云冈石窟    北魏    1    石窟寺及石刻    大同市    云冈区    1    中国三大石窟之一，北魏皇家石窟群，世界文化遗产；第八批吴官屯、鲁班窑石窟并入    ${url}.shtml
2    羊头山石窟    北魏至唐    6    石窟寺及石刻    晋城市    高平市    2    北魏至唐摩崖造像石窟群    ${url}.shtml`;
    assert.equal(c.format(input), expected);
    assert.equal(c.format(input, 'ai-text'), expected);
    assert.equal(c.format(expected), expected);
});

test('handles CRLF, tabs and paragraphs while preserving English word spacing', () => {
    const input = '第一段被截\r\n\t断了。\r\n\r\n\tHello\r\n\tworld\r\n\thttps://example.com/long\r\n\t/path.html';
    assert.equal(c.format(input), '第一段被截断了。\n\nHello world https://example.com/long/path.html');
});

test('AI formatting keeps structured formats and ordinary text intact',()=>{
 for(const value of ['普通文本','第一行\n第二行','第一行\n    第二行\n第三行'])assert.equal(c.format(value),value);
 const ai='第一行\n    第二行';
 assert.equal(c.format(ai,'text'),ai);
 assert.equal(c.format('第一行\n第二行','ai-text'),'第一行第二行');
 assert.equal(c.format('第一行\r\u3000第二行\r\u3000第三行'),'第一行第二行第三行');
 assert.equal(c.format('{\n    "name":"云冈石窟"\n    }'),'{\n  "name": "云冈石窟"\n}');
 assert.throws(()=>c.format('{\n    "name":\n    }'));
 assert(c.format('<root>\n    <name>云冈石窟</name>\n    </root>').includes('<name>云冈石窟</name>'));
 assert(c.format('select name from sites').includes('SELECT'));
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
