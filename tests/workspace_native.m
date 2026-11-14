#import "../src/theme.m"
#import "../src/workspace.m"
#include <stdio.h>
#include <stdlib.h>
#import <WebKit/WebKit.h>
static NSEvent *key(NSString *characters,NSEventModifierFlags flags) {
 return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:0
   windowNumber:0 context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:0];
}
static NSString *currentStep=@"startup";
static NSWindow *testWindow;
static void failAt(int line,NSString *message) __attribute__((noreturn));
static void failAt(int line,NSString *message) {
 fflush(stdout);
 fprintf(stderr,"FAIL tests/workspace_native.m:%d [%s]: %s\n",line,currentStep.UTF8String,message.UTF8String);
 if(testWindow) {
  NSResponder *responder=testWindow.firstResponder;
  fprintf(stderr,"UI state: active=%d, mainIsTestWindow=%d, keyIsTestWindow=%d, firstResponder=%s\n",
   NSApp.active,NSApp.mainWindow==testWindow,NSApp.keyWindow==testWindow,
   responder?NSStringFromClass(responder.class).UTF8String:"none");
 }
 fflush(stderr);
 // exit(), unlike assert()/abort(), reports failure without a macOS crash report/dialog.
 exit(EXIT_FAILURE);
}
#define CHECK(condition) do { if(!(condition)) failAt(__LINE__,[NSString stringWithFormat:@"check failed: %s",#condition]); } while(0)
static void step(NSString *name) {
 currentStep=name;
 fprintf(stderr,"STEP %s\n",name.UTF8String);
}
static void spinAt(BOOL (^done)(void),int line,NSString *condition,NSTimeInterval timeout) {
 NSTimeInterval started=NSProcessInfo.processInfo.systemUptime;
 while(!done()) {
  NSTimeInterval elapsed=NSProcessInfo.processInfo.systemUptime-started;
  if(elapsed>=timeout)failAt(line,[NSString stringWithFormat:@"timeout after %.2fs waiting for %@",elapsed,condition]);
  NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:MIN(0.01,timeout-elapsed)] inMode:NSDefaultRunLoopMode dequeue:YES];
  if(event)[NSApp sendEvent:event];
 }
}
#define spin(done) spinAt((done),__LINE__,[NSString stringWithUTF8String:#done],10)
static void checkJavaScriptError(NSError *error,int line) {
 if(error)failAt(line,[NSString stringWithFormat:@"JavaScript failed: %@",error.localizedDescription]);
}
static id jsAt(WKWebView *view,NSString *script,int line) {
 __block BOOL done=NO;__block id result;__block NSError *failure;
 [view evaluateJavaScript:script completionHandler:^(id value,NSError *error){failure=error;result=value;done=YES;}];
 spinAt(^BOOL{return done;},line,@"JavaScript completion",10);
 checkJavaScriptError(failure,line);return result;
}
#define js(view,...) jsAt((view),(__VA_ARGS__),__LINE__)
static void editKey(NSWindow *window, NSString *characters, BOOL shift) {
 // Losing focus is a test failure, not a reason to repeatedly reactivate the window.
 if(NSApp.mainWindow!=window)failAt(__LINE__,[NSString stringWithFormat:@"cannot send Command-%@: test window lost main-window status",characters]);
 NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
  modifierFlags:NSEventModifierFlagCommand|(shift?NSEventModifierFlagShift:0) timestamp:0
  windowNumber:window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO
  keyCode:[@{@"a":@0,@"b":@11,@"c":@8,@"f":@3,@"i":@34,@"u":@32,@"v":@9,@"x":@7,@"z":@6}[characters] unsignedShortValue]];
 BOOL forwarded=forwardEditingKey(event);
 if(!forwarded)fprintf(stderr,"Failed to forward Command-%s (main=%d, webview=%d)\n",characters.UTF8String,NSApp.mainWindow==window,focusedWebView(event)!=nil);
 CHECK(forwarded);
}
static unsigned int lastWorkspace = 99;
static void ignoreWorkspace(unsigned int index) { lastWorkspace = index; }
@interface CNoteTestWebView : WKWebView @end
@implementation CNoteTestWebView @end
static NSUInteger hostRefreshes, hostFallbackCloses;
static void hostEvent(void *context, int event) { if (event == 0) hostRefreshes++; else hostFallbackCloses++; }
static void navigationMatching(void) {
 unsigned short codes[]={123,124,125,126};
 unichar arrows[]={NSLeftArrowFunctionKey,NSRightArrowFunctionKey,NSDownArrowFunctionKey,NSUpArrowFunctionKey};
 for(unsigned int i=0;i<4;i++) {
  for(NSNumber *modifier in @[@0,@(NSEventModifierFlagShift),@(NSEventModifierFlagOption),@(NSEventModifierFlagCommand)]) {
   NSEventModifierFlags flags=NSEventModifierFlagFunction|modifier.unsignedIntegerValue;
   NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:123
    windowNumber:0 context:nil characters:@"\x1e" charactersIgnoringModifiers:@"\x1e" isARepeat:YES keyCode:codes[i]];
   NSEvent *normalized=navigationEvent(event);
   CHECK([normalized.characters isEqualToString:[NSString stringWithCharacters:&arrows[i] length:1]]);
   CHECK([normalized.charactersIgnoringModifiers isEqualToString:normalized.characters]);
   CHECK(normalized.keyCode==event.keyCode && normalized.modifierFlags==flags && normalized.isARepeat);
   CHECK(normalized.timestamp==123);
   CHECK(navigationEvent(normalized)==normalized);
  }
 }
 NSEvent *ordinary=key(@"a",0);
 CHECK(navigationEvent(ordinary)==ordinary);
}
static void webEditing(void) {
 step(@"UI / activate test window and wait for NSApp.mainWindow");
 [NSApplication sharedApplication];
 [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
 [NSApp finishLaunching];
 NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,600,400)
  styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
 testWindow=window;
 WKWebView *view=[[CNoteTestWebView alloc] initWithFrame:window.contentView.bounds];
 window.contentView=view;[window makeKeyAndOrderFront:nil];[window makeMainWindow];
 [NSApp activateIgnoringOtherApps:YES];[window makeKeyWindow];
 spin(^BOOL{return NSApp.mainWindow==window;});
 step(@"UI / install workspace key monitor");
 CHECK(cnote_workspace_install(ignoreWorkspace));
 step(@"UI / load basic clipboard fixture");
 [view loadHTMLString:@"<textarea id='input'>hello clipboard</textarea><div id='rich' contenteditable='true'>hello clipboard</div>" baseURL:nil];
 spin(^BOOL{return !view.loading;});
 for(NSString *field in @[@"input",@"rich"]) {
  step([NSString stringWithFormat:@"clipboard / %@ / focus and copy",field]);
  js(view,[NSString stringWithFormat:@"window.target=document.getElementById('%@');target.focus()",field]);
  [window makeFirstResponder:view];
  [NSPasteboard.generalPasteboard clearContents];
  editKey(window,@"a",NO);js(view,@"0");editKey(window,@"c",NO);
  spin(^BOOL{return [[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] isEqualToString:@"hello clipboard"];});
  step([NSString stringWithFormat:@"clipboard / %@ / cut",field]);
  editKey(window,@"x",NO);
  CHECK([js(view,@"target.value??target.textContent") isEqualToString:@""]);
  step([NSString stringWithFormat:@"clipboard / %@ / paste",field]);
  editKey(window,@"v",NO);
  spin(^BOOL{return [js(view,@"target.value??target.textContent") isEqualToString:@"hello clipboard"];});
  step([NSString stringWithFormat:@"clipboard / %@ / undo and redo",field]);
  editKey(window,@"z",NO);
  CHECK([js(view,@"target.value??target.textContent") isEqualToString:@""]);
  editKey(window,@"z",YES);
  CHECK([js(view,@"target.value??target.textContent") isEqualToString:@"hello clipboard"]);
 }
 step(@"UI / load embedded editor fixture");
 NSString *fixture=[NSString stringWithContentsOfFile:@"target/workspace-native.html" encoding:NSUTF8StringEncoding error:nil];
 CHECK(fixture);
 [view loadHTMLString:fixture baseURL:nil];
 spin(^BOOL{return !view.loading;});
 step(@"tools / restore draft and wait for Ace input");
 js(view,@"cnoteTools.receive({type:'tool_state',state:{text:'hello clipboard'}});cnoteTools.show(1)");
 spin(^BOOL{return [js(view,@"!!document.querySelector('#tool-text-editor .ace_text-input')") boolValue];});
 step(@"tools / clipboard copy");
 js(view,@"ace.edit('tool-text-editor').focus()");
 [NSPasteboard.generalPasteboard clearContents];
 editKey(window,@"a",NO);js(view,@"0");editKey(window,@"c",NO);
 spin(^BOOL{return [[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] isEqualToString:@"hello clipboard"];});
 step(@"tools / clipboard cut");
 editKey(window,@"x",NO);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@""];});
 step(@"tools / clipboard paste");
 editKey(window,@"v",NO);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@"hello clipboard"];});
 step(@"tools / undo and redo");
 editKey(window,@"z",NO);
 CHECK([js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@""]);
 editKey(window,@"z",YES);
 CHECK([js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@"hello clipboard"]);
 step(@"tools / prepare arrow navigation");
 // Navigation must move the caret, including the reported U+001E encoding.
 js(view,@"ace.edit('tool-text-editor').setValue('first\\nsecond\\nthird',-1);ace.edit('tool-text-editor').focus()");
 step(@"tools / ArrowDown");
 cnote_workspace_test_navigation(2,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().row===1") boolValue];});
 step(@"tools / ArrowRight");
 cnote_workspace_test_navigation(1,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().column===1") boolValue];});
 step(@"tools / ArrowLeft");
 cnote_workspace_test_navigation(0,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().column===0") boolValue];});
 step(@"tools / ArrowUp");
 cnote_workspace_test_navigation(3,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().row===0") boolValue];});
 step(@"tools / Shift+ArrowDown selection");
 cnote_workspace_test_navigation(2,1);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getSelectedText()==='first\\n'") boolValue];});
 CHECK([js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@"first\nsecond\nthird"]);
 js(view,@"cnoteTools.show(0);cnote.receive({type:'load',id:'arrows',title:'Arrows',html:'<p>first</p><p>second</p><p>third</p>'});const editor=document.getElementById('editor');editor.focus();const range=document.createRange();range.setStart(editor.firstChild.firstChild,0);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range)");
 step(@"notes / ArrowDown");
 cnote_workspace_test_navigation(2,0);
 spin(^BOOL{return [js(view,@"getSelection().anchorNode.textContent==='second'") boolValue];});
 CHECK([js(view,@"document.getElementById('editor').innerHTML") isEqualToString:@"<p>first</p><p>second</p><p>third</p>"]);
 for(NSString *letter in @[@"b",@"i",@"u"]) {
  step([NSString stringWithFormat:@"notes / format Command-%@, undo and redo",letter]);
  NSString *command=[@{@"b":@"bold",@"i":@"italic",@"u":@"underline"} objectForKey:letter];
  js(view,@"(()=>{document.getElementById('editor').focus();const r=document.createRange();r.selectNodeContents(document.getElementById('editor'));getSelection().removeAllRanges();getSelection().addRange(r);})()");
  NSString *state=[NSString stringWithFormat:@"document.queryCommandState('%@')",command];
  NSEvent *formatEvent=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
   modifierFlags:NSEventModifierFlagCommand timestamp:NSProcessInfo.processInfo.systemUptime
   windowNumber:window.windowNumber context:nil characters:letter charactersIgnoringModifiers:letter
   isARepeat:NO keyCode:[@{@"b":@11,@"i":@34,@"u":@32}[letter] unsignedShortValue]];
  [NSApp postEvent:formatEvent atStart:NO];
  spin(^BOOL{return [js(view,state) boolValue];});
  editKey(window,@"z",NO);CHECK(![js(view,state) boolValue]);
  editKey(window,@"z",YES);CHECK([js(view,state) boolValue]);
  editKey(window,letter,NO);CHECK(![js(view,state) boolValue]);
 }
 NSString *before=js(view,@"document.getElementById('editor').innerHTML");
 // Keep the native key map in sync with every shortcut advertised by the editor.
 step(@"notes / native shortcut map matches editor catalog");
 for(NSDictionary *shortcut in js(view,@"cnote.shortcuts")) {
  NSEventModifierFlags flags=NSEventModifierFlagCommand;
  if([shortcut[@"shift"] boolValue])flags|=NSEventModifierFlagShift;
  if([shortcut[@"alt"] boolValue])flags|=NSEventModifierFlagOption;
  CHECK([noteCommand(key(shortcut[@"key"],flags)) isEqual:shortcut[@"id"]]);
 }
 for(NSDictionary *sample in @[
  @{@"key":@"2",@"flags":@(NSEventModifierFlagOption),@"code":@19,@"check":@"!!document.querySelector('#editor h2')"},
  @{@"key":@"&",@"flags":@(NSEventModifierFlagShift),@"code":@26,@"check":@"!!document.querySelector('#editor ol li')"},
  @{@"key":@"c",@"flags":@(NSEventModifierFlagShift),@"code":@8,@"check":@"!!document.querySelector('#editor pre')"},
  @{@"key":@"k",@"flags":@0,@"code":@40,@"check":@"document.getElementById('dialog-title').textContent==='插入或编辑链接'"},
  @{@"key":@"f",@"flags":@0,@"code":@3,@"check":@"!document.getElementById('note-find').hidden"},
  @{@"key":@"/",@"flags":@0,@"code":@44,@"check":@"document.getElementById('dialog-title').textContent==='笔记快捷键'"}
 ]) {
  step([NSString stringWithFormat:@"notes / native Command-%@ / %@",sample[@"key"],sample[@"check"]]);
  js(view,@"(()=>{document.getElementById('dialog').close();document.getElementById('editor').innerHTML='<p>Native shortcut</p>';cnote.focusEditor();const r=document.createRange();r.selectNodeContents(document.getElementById('editor'));getSelection().removeAllRanges();getSelection().addRange(r);})()");
  NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand|[sample[@"flags"] unsignedIntegerValue]
   timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:sample[@"key"] charactersIgnoringModifiers:sample[@"key"] isARepeat:NO keyCode:[sample[@"code"] unsignedShortValue]];
  [NSApp postEvent:event atStart:NO];spin(^BOOL{return [js(view,sample[@"check"]) boolValue];});
 }
 step(@"notes / paste plain text");
 js(view,@"document.getElementById('dialog').close();cnote.focusEditor()");
 [NSPasteboard.generalPasteboard clearContents];[NSPasteboard.generalPasteboard setString:@"a\tb\n1\t2" forType:NSPasteboardTypeString];
 editKey(window,@"v",YES);spin(^BOOL{return [js(view,@"document.getElementById('editor').textContent.includes('a')&&!document.querySelector('#editor table')") boolValue];});
 before=js(view,@"document.getElementById('editor').innerHTML");
 step(@"notes / ignore formatting while dialog is open");
 js(view,@"cnote.action('new')");editKey(window,@"b",NO);
 CHECK([js(view,@"document.getElementById('editor').innerHTML") isEqual:before]);
 js(view,@"document.getElementById('dialog').close();cnoteTools.show(1);ace.edit('tool-text-editor').focus()");
 editKey(window,@"b",NO);CHECK([js(view,@"document.getElementById('editor').innerHTML") isEqual:before]);
 step(@"tools / Command-F reaches focused input (not an Ace searchbox wait)");
 // Ace's optional searchbox module is not bundled. Verify event forwarding itself.
 js(view,@"document.activeElement.addEventListener('keydown',e=>{if(e.metaKey&&e.key.toLowerCase()==='f'){window.toolShortcutForwarded=true;e.preventDefault();e.stopImmediatePropagation();}},true)");
 editKey(window,@"f",NO);spin(^BOOL{return [js(view,@"!!window.toolShortcutForwarded") boolValue];});
 step(@"OneDrive / Command-6 and native copy dispatch");
 cnote_workspace_test_key(5);
 spin(^BOOL{return lastWorkspace==5;});
 js(view,@"window.driveMessages=[];window.ipc.postMessage=raw=>{const m=JSON.parse(raw);if(m.type==='drive'){driveMessages.push(m);setTimeout(()=>cnoteDrive.receive({request:m.request,data:m.op==='list'?{folder:{id:'root'},items:[{id:'file',name:'测试.txt',size:4,eTag:'v1'}]}:{directory:'/Downloads/test'}}),0);}};cnoteDrive.account(true,'Fixture account');cnoteTools.show(5)");
 spin(^BOOL{return [js(view,@"!!document.querySelector('#drive-list [data-id=file]')") boolValue];});
 js(view,@"document.querySelector('#drive-list [data-id=file]').click()");
 editKey(window,@"c",NO);
 spin(^BOOL{return [js(view,@"driveMessages.some(m=>m.op==='download'&&m.copy===true&&m.ids[0]==='file')") boolValue];});
 editKey(window,@"f",NO);
 spin(^BOOL{return [js(view,@"document.activeElement.id==='drive-search'") boolValue];});
 step(@"Reload / intercept native methods and context-menu actions before navigation");
 CHECK(cnote_web_host_attach((__bridge void *)view,NULL,hostEvent,NULL));
 js(view,@"window.reloadSentinel=document.getElementById('drive-list');document.getElementById('drive-search').value='unsaved search'");
 [view reload]; [view reloadFromOrigin];
 [view performSelector:NSSelectorFromString(@"reload:") withObject:nil];
 [view performSelector:NSSelectorFromString(@"reloadFromOrigin:") withObject:nil];
 CHECK(hostRefreshes==4);
 NSMenu *contextMenu=[NSMenu new];NSMenuItem *reload=[[NSMenuItem alloc] initWithTitle:@"Reload" action:NSSelectorFromString(@"reload:") keyEquivalent:@""];reload.target=view;[contextMenu addItem:reload];
 [NSNotificationCenter.defaultCenter postNotificationName:NSMenuDidBeginTrackingNotification object:contextMenu];
 CHECK([reload.title isEqualToString:@"刷新当前工作区"]);
 [contextMenu performActionForItemAtIndex:0];CHECK(hostRefreshes==5);
 CHECK([js(view,@"cnoteTools.workspace===5&&reloadSentinel===document.getElementById('drive-list')&&document.getElementById('drive-search').value==='unsaved search'") boolValue]);
 step(@"Quit / healthy editor retains its save barrier");
 js(view,@"window.nativeCloseCalls=0;window.cnote={action:()=>nativeCloseCalls++}");
 CHECK(cnote_web_host_close((__bridge void *)view));
 spin(^BOOL{return [js(view,@"nativeCloseCalls===1") boolValue];});
 CHECK(hostFallbackCloses==0);
 cnote_web_host_cancel_close((__bridge void *)view);
 step(@"Quit / a blank document closes through the native backend callback");
 [view loadHTMLString:@"<html><body></body></html>" baseURL:nil];
 spin(^BOOL{return !view.loading;});
 CHECK(cnote_web_host_close((__bridge void *)view));
 spin(^BOOL{return hostFallbackCloses==1;});
 CHECK(cnote_web_host_close((__bridge void *)view));
 CHECK(hostFallbackCloses==1);
 [window orderOut:nil];
}
int main(int argc,const char **argv) {
 @autoreleasepool { @try {
  // These failure probes never create NSApplication, a window or a WebView.
  if(argc==3 && strcmp(argv[1],"--self-test-failure")==0) {
   step([NSString stringWithFormat:@"headless failure probe / %s",argv[2]]);
   if(strcmp(argv[2],"timeout")==0)spinAt(^BOOL{return NO;},__LINE__,@"intentional false predicate",0);
   else if(strcmp(argv[2],"check")==0)CHECK(NO);
   else if(strcmp(argv[2],"javascript")==0)checkJavaScriptError([NSError errorWithDomain:@"CNoteNativeTest" code:1 userInfo:@{NSLocalizedDescriptionKey:@"intentional JavaScript failure"}],__LINE__);
   else if(strcmp(argv[2],"exception")==0)@throw [NSException exceptionWithName:@"CNoteNativeTest" reason:@"intentional exception" userInfo:nil];
   else {fprintf(stderr,"unknown failure probe: %s\n",argv[2]);return 2;}
  }
  BOOL noUI=argc==2 && strcmp(argv[1],"--no-ui")==0;
  if(argc!=1 && !noUI){fprintf(stderr,"usage: workspace-native-tests [--no-ui | --self-test-failure timeout|check|javascript|exception]\n");return 2;}
  step(@"headless workspace, editing and navigation key matching");
  for(unsigned int i=0;i<6;i++) {
   NSString *s=[NSString stringWithFormat:@"%u",i+1];
   CHECK(workspaceIndex(key(s,NSEventModifierFlagCommand))==i);
   CHECK(workspaceIndex(key(s,NSEventModifierFlagCommand|NSEventModifierFlagCapsLock))==i);
   CHECK(workspaceIndex(key(s,0))==-1);
   for(NSNumber *modifier in @[@(NSEventModifierFlagControl),@(NSEventModifierFlagOption),@(NSEventModifierFlagShift)])
    CHECK(workspaceIndex(key(s,NSEventModifierFlagCommand|modifier.unsignedIntegerValue))==-1);
  }
  CHECK(workspaceIndex(key(@"7",NSEventModifierFlagCommand))==-1);
  for(NSString *s in @[@"a",@"c",@"v",@"x",@"z",@"b",@"i",@"u"]) {
   CHECK(editingSelector(key(s,NSEventModifierFlagCommand))!=NULL);
   CHECK(editingSelector(key(s,0))==NULL);
   CHECK(editingSelector(key(s,NSEventModifierFlagCommand|NSEventModifierFlagOption))==NULL);
   CHECK(editingSelector(key(s,NSEventModifierFlagCommand|NSEventModifierFlagControl))==NULL);
  }
  CHECK(editingSelector(key(@"z",NSEventModifierFlagCommand|NSEventModifierFlagShift))==@selector(redo:));
  CHECK(editingSelector(key(@"a",NSEventModifierFlagCommand|NSEventModifierFlagShift))==NULL);
  for(NSString *s in @[@"b",@"i",@"u"])CHECK(editingSelector(key(s,NSEventModifierFlagCommand|NSEventModifierFlagShift))==NULL);
  navigationMatching();
  puts("Native workspace, editing and navigation key matching passed.");
  const char *nativeUI=getenv("CNOTE_NATIVE_UI_TESTS");
  if(!noUI && nativeUI && strcmp(nativeUI,"1")==0) {
   webEditing();
   puts("WebKit editing, formatting shortcuts, arrow navigation and Shift selection passed.");
  }
  return EXIT_SUCCESS;
 } @catch(NSException *exception) {
  failAt(__LINE__,[NSString stringWithFormat:@"Objective-C exception %@: %@",exception.name,exception.reason]);
 } }
}
