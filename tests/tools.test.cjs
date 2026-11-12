const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium,webkit}=require('playwright'),html=require('./editor-fixture.cjs')();
for(const [name,type]of [['Chromium',chromium],['WebKit',webkit]])test(name+' local tools offline',async t=>{
 const executablePath=name==='Chromium'?process.env.CNOTE_CHROMIUM_EXECUTABLE:process.env.CNOTE_WEBKIT_EXECUTABLE;
 const browser=await type.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
  const context=await browser.newContext({viewport:{width:1100,height:800}}),page=await context.newPage(),requests=[],errors=[];
  page.setDefaultTimeout(10000);
  // WebKit's simulated offline mode also blocks blob workers. Abort every real network request instead.
  await context.route(/^https?:\/\//,route=>route.abort('internetdisconnected'));
  page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(`<script>window.messages=[];window.ipc={postMessage:raw=>{const m=JSON.parse(raw);messages.push(m);if(m.type==='tool_ready')setTimeout(()=>cnoteTools.receive({type:'tool_state',state:{}}),0);if(m.type==='tool_save'&&!window.blockToolSave)setTimeout(()=>cnoteTools.receive({type:'tool_saved',seq:m.seq}),5);if(m.type==='change')setTimeout(()=>cnote.receive({type:'saved',id:m.id,seq:m.seq}),5);if(m.type==='workspace')cnoteTools.show(m.index);}};</script>`+html);
  await page.waitForFunction(()=>window.cnote&&window.cnoteTools);
  const setInput=value=>page.evaluate(value=>ace.edit('tool-text-editor').setValue(value,-1),value);
  const textValue=()=>page.evaluate(()=>cnoteTools.state.text);
  const waitValue=value=>page.waitForFunction(value=>cnoteTools.state.text.replace(/\r\n/g,'\n')===value,value,{timeout:5000});
  const action=op=>page.locator(`[data-text-op="${op}"]`).click();
  await t.test('opened text waits for draft restore, switches pages and preserves undo',async()=>{
   await page.evaluate(()=>{
    cnoteTools.receive({type:'tool_open_text',name:'中文 空格.md',text:'# 标题\n\nMarkdown 正文'});
    cnoteTools.receive({type:'tool_state',state:{text:'原有草稿',left:'保留 Diff'}});
   });
   await waitValue('# 标题\n\nMarkdown 正文');
   assert.equal(await page.evaluate(()=>cnoteTools.workspace),1);
   assert.equal(await page.evaluate(()=>cnoteTools.state.left),'保留 Diff');
   await page.locator('#text-undo').click();await waitValue('原有草稿');
   await page.evaluate(()=>{cnoteTools.show(2);cnoteTools.receive({type:'tool_open_text',name:'sample.txt',text:'第二份文本'});});
   await waitValue('第二份文本');assert.equal(await page.evaluate(()=>cnoteTools.workspace),1);
   await page.evaluate(()=>cnoteTools.receive({type:'tool_open_text',name:'binary.bin',error:'文件包含二进制内容'}));
   assert.equal(await textValue(),'第二份文本');assert((await page.locator('#tool-status').textContent()).includes('二进制'));
   await page.evaluate(()=>cnoteTools.flush());
   assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='tool_save').at(-1).state.text),'第二份文本');
  });
  await t.test('jsonpack has one editor and compact controls that apply directly and undo',async()=>{
   await page.keyboard.press('Meta+2');await page.waitForSelector('#tool-text-editor .ace_text-input');
   assert.equal(await page.locator('#text-tool select').count(),0);
   assert.equal(await page.locator('#tool-text-result, #text-apply, #text-preview').count(),0);
   for(const id of ['text-filter','text-remove','text-delimiter','text-field','text-newline'])assert(await page.locator('#'+id).isVisible());
   const original='{"id":9007199254740993123}';await setInput(original);await action('format');
   await page.waitForFunction(()=>cnoteTools.state.text.includes('\n'));
   assert((await textValue()).includes('9007199254740993123'));
   await page.locator('#text-undo').click();await waitValue(original);
   await page.screenshot({path:path.join('/tmp','cnote-jsonpack-'+name+'.png')});
  });
  await t.test('line operations directly transform the single document and are undoable',async()=>{
   for(const [op,input,output] of [['trim-empty','苹果\n\n香蕉','苹果\n香蕉'],['join','第一行\n 第二行 ','第一行第二行'],['sort','b\na','a\nb'],['unique','b\na\nb','a\nb']]){
    await setInput(input);await action(op);await waitValue(output);await page.locator('#text-undo').click();await waitValue(input);
   }
  });
  await t.test('inline inputs execute on Enter or blur and clear after success',async()=>{
   await setInput('成功：保存\n错误：断开\n成功：同步');await page.locator('#text-filter').fill('^错误');await page.locator('#text-filter').press('Enter');await waitValue('错误：断开');
   assert.equal(await page.locator('#text-filter').inputValue(),'');
   await setInput('#苹果 #香蕉');await page.locator('#text-remove').fill('#');await page.locator('#text-remove').press('Tab');await waitValue('苹果 香蕉');
   await setInput('苹果,香蕉\n橙子');await page.locator('#text-newline').fill(',');await page.locator('#text-newline').press('Enter');await waitValue('苹果\n香蕉\n橙子');
   await setInput('小明,北京,12\n小红,上海,13');await page.locator('#text-delimiter').fill(',');await page.locator('#text-field').fill('2');await page.locator('#text-field').press('Enter');await waitValue('北京\n上海');
   assert.equal(await page.locator('#text-field').inputValue(),'');assert.equal(await page.locator('#text-delimiter').inputValue(),'');
  });
  await t.test('invalid operations preserve text and parameters for correction',async()=>{
   await setInput('{invalid');await action('format');await page.waitForFunction(()=>document.getElementById('text-feedback').dataset.error==='true');assert.equal(await textValue(),'{invalid');
   await page.locator('#text-filter').fill('[');await page.locator('#text-filter').press('Enter');await page.waitForFunction(()=>/regular expression/i.test(document.getElementById('text-feedback').textContent));
   assert.equal(await textValue(),'{invalid');assert.equal(await page.locator('#text-filter').inputValue(),'[');await page.locator('#text-filter').fill('');
   await page.locator('#text-field').fill('2');await page.locator('#text-field').press('Enter');assert.equal(await textValue(),'{invalid');await page.locator('#text-field').fill('');
  });
  await t.test('smart decode directly applies text safely and can be undone',async()=>{
   const input='JUU0JUJEJUEwJUU1JUE1JUJE';await setInput(input);await action('smartdecode');await waitValue('你好');
   assert.equal(await page.locator('#text-decode-layers details').count(),2);assert((await page.locator('#text-feedback').textContent()).includes('Base64 → URL 编码'));
   await page.locator('#text-undo').click();await waitValue(input);
   await setInput('&lt;img src=x onerror=alert(1)&gt;');await action('smartdecode');await waitValue('<img src=x onerror=alert(1)>');assert.equal(await page.locator('#text-decode-layers img').count(),0);
   await setInput('ordinary text');await action('smartdecode');await page.waitForFunction(()=>document.getElementById('text-feedback').textContent.includes('未识别到'));
  });
  await t.test('nested URL decoding preserves plus signs in query parameters and supports undo',async()=>{
   const original='https%3A%2F%2Fexample.com%2F%3Ftoken%3Da%2Bb%26next%3D%252Fhome';
   await setInput(original);await action('smartdecode');await waitValue('https://example.com/?token=a+b&next=/home');
   assert.equal(await page.locator('#text-decode-layers details').count(),2);
   await action('smartdecode');await page.waitForFunction(()=>document.getElementById('text-feedback').textContent.includes('未识别到'));
   assert.equal(await textValue(),'https://example.com/?token=a+b&next=/home');
   await page.locator('#text-undo').click();await waitValue(original);
  });
  await t.test('ampersands remain readable through decoding and draft serialization',async()=>{
   for(const input of ['https://example.com/?a=1%26b=2',String.raw`https://example.com/?a=1\u0026b=2`,'https://example.com/?a=1%5Cu0026b=2']){
    await setInput(input);await action('smartdecode');await waitValue('https://example.com/?a=1&b=2');
    await page.evaluate(()=>cnoteTools.flush());
    const saved=await page.evaluate(()=>messages.filter(m=>m.type==='tool_save').at(-1).state.text);
    assert.equal(saved,'https://example.com/?a=1&b=2');
    await page.waitForFunction(()=>document.querySelector('#tool-text-editor .ace_text-layer').textContent.includes('&b=2'));
   }
  });
  await t.test('format button restores Unicode ampersands in URLs and JSON and remains undoable',async()=>{
   for(const original of [String.raw`https://example.com/?a=1\u0026b=2`,String.raw`{"url":"https://example.com/?a=1\u0026b=2","id":9007199254740993123}`]){
    await setInput(original);await action('format');
    await page.waitForFunction(()=>cnoteTools.state.text.includes('&b=2'));
    assert.equal((await textValue()).includes(String.raw`\u0026`),false);
    if(original.startsWith('{'))assert((await textValue()).includes('9007199254740993123'));
    await page.locator('#text-undo').click();await waitValue(original);
   }
  });
  await t.test('format auto detects JSON XML SQL and AI text',async()=>{
   for(const [input,expected] of [['<note><title>CNote</title></note>','<note>\n  <title>CNote</title>\n</note>'],['select name from notes','SELECT\n  name\nFROM\n  notes'],['第一段被截\n    断了。\n\n    Hello\n    world','第一段被截断了。\n\nHello world']]){
    await setInput(input);await action('format');await waitValue(expected);await page.locator('#text-undo').click();await waitValue(input);
   }
  });
  await t.test('whitespace and themes only change display, native editing targets focused input',async()=>{
   const input='a b\t c\n  d';await setInput(input);await page.locator('#text-show-whitespace').check();
   await page.waitForFunction(()=>document.querySelector('#tool-text-editor .ace_text-layer').textContent.includes('·'));
   assert.equal((await page.locator('#tool-text-editor .ace_text-layer').textContent()).includes('Â'),false);assert.equal(await textValue(),input);
   await page.locator('#text-show-whitespace').uncheck();
   for(const theme of require('../editor/themes.json')){await page.evaluate(id=>cnoteTheme.set(id),theme.id);assert.equal(await page.locator('#tool-text-editor').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb('+theme.bg.match(/../g).map(v=>parseInt(v,16)).join(', ')+')');assert.equal(await textValue(),input);}
   await page.evaluate(()=>cnoteTheme.set('system'));
   await page.locator('#text-remove').fill('pattern');await page.evaluate(()=>cnoteTools.edit('selectAll'));assert.deepEqual(await page.locator('#text-remove').evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,7]);
   await page.locator('#text-remove').fill('');
   await page.evaluate(()=>ace.edit('tool-text-editor').focus());const original=await textValue();for(const char of ['\u001e','\uf701'])await page.keyboard.insertText(char);assert.equal(await textValue(),original);
  });
  await t.test('an asynchronous transform cannot overwrite newer typing',async()=>{
   await page.evaluate(()=>{window.originalWorkerPost=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){if(args[0].task==='textOp')setTimeout(()=>originalWorkerPost.apply(this,args),150);else originalWorkerPost.apply(this,args);};ace.edit('tool-text-editor').setValue('{"old":1}',-1);});
   await action('format');await setInput('new typing');await page.waitForFunction(()=>document.getElementById('text-feedback').textContent.includes('已保留新输入'));assert.equal(await textValue(),'new typing');await page.evaluate(()=>Worker.prototype.postMessage=originalWorkerPost);
  });
  await t.test('diff works offline, switching keeps both editor documents',async()=>{
   const original=await textValue();
   await page.keyboard.press('Meta+3');
   await page.evaluate(()=>{ace.edit('tool-diff-left').setValue('same\nold\n',-1);ace.edit('tool-diff-right').setValue('same\nnew\n',-1);});
   await page.waitForFunction(()=>document.getElementById('diff-count').textContent==='+1 / −1');
   assert.equal(await page.locator('#diff-output .removed').count(),1);assert.equal(await page.locator('#diff-output .added').count(),1);
   await page.keyboard.press('Meta+2');assert.equal(await page.evaluate(()=>ace.edit('tool-text-editor').getValue()),original);
   await page.keyboard.press('Meta+3');assert.equal(await page.evaluate(()=>ace.edit('tool-diff-right').getValue()),'same\nnew\n');
  });
  await t.test('Command 1 resumes the note at its saved caret position',async()=>{
   await page.evaluate(()=>{
    cnote.receive({type:'load',id:'resume',title:'Resume',html:'<p>Hello</p>'});
    const editor=document.getElementById('editor');editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
   });
   await page.waitForTimeout(30);await page.keyboard.press('Meta+2');await page.keyboard.press('Meta+1');await page.keyboard.type(' world');
   assert.equal(await page.locator('#editor').textContent(),'Hello world');
  });
  await t.test('CSV import, cell edits, numeric sorting, transpose and undo',async()=>{
   await page.keyboard.press('Meta+4');await page.locator('#table-input').fill('name,n\nx,10\ny,2');await page.locator('#table-import').click();
   await page.waitForSelector('#table-grid tbody tr');assert.equal(await page.locator('#table-grid tbody tr').count(),2);
   await page.locator('#table-column').selectOption('1');await page.getByRole('button',{name:'升序',exact:true}).click();
   await page.waitForFunction(()=>cnoteTools.state.rows[1][0]==='y');
   const cell=page.locator('#table-grid tbody input').first();await cell.fill('edited');await cell.blur();
   assert.equal(await page.evaluate(()=>cnoteTools.state.rows[1][0]),'edited');
   await page.locator('#table-undo').click();assert.equal(await page.evaluate(()=>cnoteTools.state.rows[1][0]),'y');
   await page.getByRole('button',{name:'转置',exact:true}).click();await page.waitForFunction(()=>cnoteTools.state.rows.length===2&&cnoteTools.state.rows[0].length===3);
   await page.locator('#table-undo').click();assert.equal(await page.evaluate(()=>cnoteTools.state.rows[0][0]),'name');
   await page.screenshot({path:path.join('/tmp','cnote-local-csv-'+name+'.png')});
  });
  await t.test('notes and CSV import or paste CSV and TSV',async()=>{
   const samples=[['name,value\n"<script>","x,y"',[['name','value'],['<script>','x,y']]],['name\tvalue\nfirst\t001',[['name','value'],['first','001']]],['type,value,info,details\na,b,c,"line1\nline2"\nd,e,f,"more\nlines"',[['type','value','info','details'],['a','b','c','line1\nline2'],['d','e','f','more\nlines']]]];
   const paste=async(selector,text,html='')=>page.locator(selector).first().evaluate((el,{text,html})=>{const data=new DataTransfer();data.setData('text/plain',text);if(html)data.setData('text/html',html);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},{text,html});
   for(const [text,expected] of samples){
    await page.evaluate(()=>{cnoteTools.show(0);cnote.receive({type:'load',id:'paste-note',title:'Paste',html:'<p>Before</p>'});cnote.focusEditor();const r=document.createRange();r.selectNodeContents(document.getElementById('editor'));r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);});
    await paste('#editor',text,'<pre>clipboard wrapper</pre>');
    const result=await page.locator('#editor table').evaluate(table=>[...table.rows].map(r=>[...r.cells].map(c=>c.innerHTML.replace(/<br\s*\/?\s*>/gi,'\n')).map(s=>{const el=document.createElement('div');el.innerHTML=s;return el.textContent;})));
    assert.deepEqual(result,expected);assert.equal(await page.locator('#editor script').count(),0);
    await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('#editor table').count(),0);
    await page.evaluate(()=>cnoteTools.show(3));await page.locator('#table-import-format').selectOption('auto');await page.locator('#table-input').fill(text);await page.locator('#table-import').click();
    await page.waitForFunction(expected=>JSON.stringify(cnoteTools.state.rows)===JSON.stringify(expected),expected);
    await paste('#table-grid tbody input',text);
    assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows[1].slice(0,2)),expected[0].slice(0,2));
    await page.locator('#table-undo').click();assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows),expected);
    await page.locator('#table-redo').click();assert.equal(await page.evaluate(()=>cnoteTools.state.rows.length),expected.length+1);
   }
   const beforeOffset=await page.evaluate(()=>cnoteTools.state.rows);
   const wrapped=page.locator('#table-grid textarea[data-row="2"][data-column="3"]');
   assert.equal(await wrapped.inputValue(),beforeOffset[2][3]);
   await wrapped.fill(beforeOffset[2][3]+'\nextra line');await wrapped.blur();
   assert.equal(await page.evaluate(()=>cnoteTools.state.rows[2][3]),beforeOffset[2][3]+'\nextra line');
   await page.locator('#table-undo').click();assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows),beforeOffset);
   await paste('#table-grid [data-row="1"][data-column="3"]','x\ty\nz\tw');
   assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows[1]),[...beforeOffset[1].slice(0,3),'x','y']);
   assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows[2].slice(3)),['z','w']);
   await page.locator('#table-undo').click();assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows),beforeOffset);
   await page.evaluate(()=>{cnoteTools.show(0);cnote.receive({type:'load',id:'plain-paste',title:'Plain',html:''});cnote.focusEditor();});
   await paste('#editor','hello, world\nnormal prose');assert.equal(await page.locator('#editor table').count(),0);
   await paste('#editor','a\tb\n1\t2','<table><tr><td>HTML formatting</td></tr></table>');
   assert.equal(await page.locator('#editor table').textContent(),'HTML formatting');
   await page.evaluate(()=>cnoteTools.show(3));
  });
  await t.test('terminal text stays text in notes and is rejected by CSV auto import',async()=>{
   const text=require('node:fs').readFileSync(path.join(__dirname,'fixtures/unsupported-terminal-table.txt'),'utf8');
   await page.evaluate(text=>{cnoteTools.show(0);cnote.receive({type:'load',id:'terminal-as-text',title:'Text',html:''});cnote.focusEditor();const data=new DataTransfer();data.setData('text/plain',text);document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
   assert.equal(await page.locator('#editor table').count(),0);
   assert.equal((await page.locator('#editor').innerText()).replace(/\s+/g,' ').trim(),text.replace(/\s+/g,' ').trim());
   await page.evaluate(()=>cnoteTools.show(3));
   assert.equal(await page.locator('#table-import-format option[value="terminal"]').count(),0);
   const before=await page.evaluate(()=>cnoteTools.state.rows);
   await page.locator('#table-import-format').selectOption('auto');await page.locator('#table-input').fill(text);await page.locator('#table-import').click();
   await page.waitForFunction(()=>document.getElementById('tool-status').dataset.error==='true');
   assert.deepEqual(await page.evaluate(()=>cnoteTools.state.rows),before);
   assert.equal(await page.locator('#table-input').inputValue(),text);
  });
  await t.test('pasting in a note table fills existing cells, expands and undoes without nesting',async()=>{
   const samples=[{plain:'x,y\nz,w'}, {plain:'x\ty\nz\tw'}, {plain:'fallback',html:'<table><tr><th><b>x</b></th><th>y</th></tr><tr><td>z<br>line</td><td>w</td></tr></table>'}];
   const original='<p>Before</p><table><tbody><tr><th>A</th><th>B</th></tr><tr><td>Keep</td><td>Replace</td></tr></tbody></table><p>After</p>';
   for(const [index,sample] of samples.entries()){
    await page.evaluate(({index,original})=>{cnoteTools.show(0);cnote.receive({type:'load',id:'paste-existing-'+index,title:'Existing table',html:original});cnote.focusEditor();const cell=document.querySelector('#editor td:last-child'),r=document.createRange();r.selectNodeContents(cell);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);}, {index,original});
    await page.locator('#editor').evaluate((el,sample)=>{const data=new DataTransfer();data.setData('text/plain',sample.plain);if(sample.html)data.setData('text/html',sample.html);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},sample);
    assert.equal(await page.locator('#editor table').count(),1);
    const rows=await page.locator('#editor table').evaluate(table=>[...table.rows].map(r=>[...r.cells].map(c=>c.textContent)));
    assert.equal(rows[0][0],'A');assert.equal(rows[0][1],'B');assert.equal(rows[1][0],'Keep');assert.equal(rows[1][1],'x');
    assert.equal(rows.length,3);assert.equal(rows[0].length,3);
    assert.equal(await page.locator('#editor > p').first().textContent(),'Before');assert.equal(await page.locator('#editor > p').last().textContent(),'After');
    if(sample.html)assert.equal(await page.locator('#editor td b').textContent(),'x');
    const after=await page.locator('#editor').innerHTML();
    await page.evaluate(()=>cnote.flush());
    const saved=await page.evaluate(()=>messages.filter(m=>m.type==='change'&&m.id.startsWith('paste-existing-')).at(-1));assert.equal(saved.html,after);
    assert(await page.evaluate(()=>{const node=getSelection().anchorNode;return !!(node.nodeType===1?node:node.parentElement).closest('td,th');}));
    await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('#editor').innerHTML(),original);
    await page.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await page.locator('#editor').innerHTML(),after);
   }
   for(const [index,table] of ['<table><tfoot><tr><td>Footer</td></tr></tfoot></table>','<table><tr><td colspan="2">Merged</td></tr></table>'].entries()){
    await page.evaluate(({index,table})=>{cnote.receive({type:'load',id:'special-table-'+index,title:'Table',html:table});cnote.focusEditor();const r=document.createRange();r.selectNodeContents(document.querySelector('#editor td'));r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);const data=new DataTransfer();data.setData('text/plain','x\ty\nz\tw');document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},{index,table});
    assert.equal(await page.locator('#editor table').count(),1);
    if(index===0){assert.equal(await page.locator('#editor tr').count(),2);assert.equal(await page.locator('#editor td').first().textContent(),'x');}
    else assert.equal(await page.locator('#editor td').getAttribute('colspan'),'2');
    await page.getByRole('button',{name:'撤销',exact:true}).click();
    assert.equal(await page.locator('#editor td').first().textContent(),index===0?'Footer':'Merged');
   }
   await page.evaluate(()=>cnoteTools.show(3));
  });
  await t.test('HTML import removes executable markup and exports local bytes',async()=>{
   await page.locator('#table-import-format').selectOption('html');await page.locator('#table-input').fill('<table><tr><th>x</th></tr><tr><td><img src="https://never.test/pixel.png" onerror="evil()">&lt;script&gt;evil()&lt;/script&gt;</td></tr></table>');await page.locator('#table-import').click();
   assert.equal(await page.evaluate(()=>cnoteTools.state.rows[1][0]),'<script>evil()</script>');assert.equal(await page.locator('#table-grid script').count(),0);
   await page.locator('#table-export-format').selectOption('xlsx');await page.locator('#table-export').click();
   await page.waitForFunction(()=>messages.some(m=>m.type==='tool_export'));
   const result=await page.evaluate(()=>messages.filter(m=>m.type==='tool_export').at(-1));assert.equal(result.filename,'CNote-table.xlsx');assert.equal(Buffer.from(result.data,'base64').subarray(0,2).toString(),'PK');
  });
  await t.test('quit waits for tool drafts as well as notes',async()=>{
   await page.evaluate(()=>{window.blockToolSave=true;ace.edit('tool-text-editor').setValue('must persist',-1);cnote.action('close');});
   await page.waitForFunction(()=>messages.some(m=>m.type==='tool_save'&&m.state.text==='must persist'));
   assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='close')),false);
   await page.evaluate(()=>cnoteTools.receive({type:'tool_saved',seq:messages.filter(m=>m.type==='tool_save').at(-1).seq}));
   await page.waitForFunction(()=>messages.some(m=>m.type==='close'));
  });
  assert.deepEqual(requests,[],'local tools requested network resources');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
