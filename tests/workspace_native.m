#import "../src/theme.m"
#import "../src/workspace.m"
#include <assert.h>
#import <WebKit/WebKit.h>
static NSEvent *key(NSString *characters,NSEventModifierFlags flags) {
 return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:0
   windowNumber:0 context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:0];
}
static void spin(BOOL (^done)(void)) {
 NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:10];
 while(!done() && deadline.timeIntervalSinceNow>0) {
  NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
  if(event)[NSApp sendEvent:event];
 }
 assert(done());
}
static id js(WKWebView *view, NSString *script) {
 __block BOOL done=NO; __block id result;
 [view evaluateJavaScript:script completionHandler:^(id value,NSError *error){assert(!error);result=value;done=YES;}];
 spin(^BOOL{return done;});return result;
}
static void editKey(NSWindow *window, NSString *characters, BOOL shift) {
 NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
  modifierFlags:NSEventModifierFlagCommand|(shift?NSEventModifierFlagShift:0) timestamp:0
  windowNumber:window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:0];
 assert(forwardEditingKey(event));
}
static void ignoreWorkspace(unsigned int index) { (void)index; }
static void navigationMatching(void) {
 unsigned short codes[]={123,124,125,126};
 unichar arrows[]={NSLeftArrowFunctionKey,NSRightArrowFunctionKey,NSDownArrowFunctionKey,NSUpArrowFunctionKey};
 for(unsigned int i=0;i<4;i++) {
  for(NSNumber *modifier in @[@0,@(NSEventModifierFlagShift),@(NSEventModifierFlagOption),@(NSEventModifierFlagCommand)]) {
   NSEventModifierFlags flags=NSEventModifierFlagFunction|modifier.unsignedIntegerValue;
   NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:123
    windowNumber:0 context:nil characters:@"\x1e" charactersIgnoringModifiers:@"\x1e" isARepeat:YES keyCode:codes[i]];
   NSEvent *normalized=navigationEvent(event);
   assert([normalized.characters isEqualToString:[NSString stringWithCharacters:&arrows[i] length:1]]);
   assert([normalized.charactersIgnoringModifiers isEqualToString:normalized.characters]);
   assert(normalized.keyCode==event.keyCode && normalized.modifierFlags==flags && normalized.isARepeat);
   assert(normalized.timestamp==123);
   assert(navigationEvent(normalized)==normalized);
  }
 }
 NSEvent *ordinary=key(@"a",0);
 assert(navigationEvent(ordinary)==ordinary);
}
static void webEditing(void) {
 [NSApplication sharedApplication];
 [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
 [NSApp finishLaunching];
 [NSApp activateIgnoringOtherApps:YES];
 NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,600,400)
  styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
 WKWebView *view=[[WKWebView alloc] initWithFrame:window.contentView.bounds];
 window.contentView=view;[window makeKeyAndOrderFront:nil];[window makeMainWindow];
 spin(^BOOL{return NSApp.mainWindow==window;});
 assert(cnote_workspace_install(ignoreWorkspace));
 [view loadHTMLString:@"<textarea id='input'>hello clipboard</textarea><div id='rich' contenteditable='true'>hello clipboard</div>" baseURL:nil];
 spin(^BOOL{return !view.loading;});
 for(NSString *field in @[@"input",@"rich"]) {
  js(view,[NSString stringWithFormat:@"window.target=document.getElementById('%@');target.focus()",field]);
  [window makeFirstResponder:view];
  [NSPasteboard.generalPasteboard clearContents];
  editKey(window,@"a",NO);js(view,@"0");editKey(window,@"c",NO);
  spin(^BOOL{return [[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] isEqualToString:@"hello clipboard"];});
  editKey(window,@"x",NO);
  assert([js(view,@"target.value??target.textContent") isEqualToString:@""]);
  editKey(window,@"v",NO);
  spin(^BOOL{return [js(view,@"target.value??target.textContent") isEqualToString:@"hello clipboard"];});
  editKey(window,@"z",NO);
  assert([js(view,@"target.value??target.textContent") isEqualToString:@""]);
  editKey(window,@"z",YES);
  assert([js(view,@"target.value??target.textContent") isEqualToString:@"hello clipboard"]);
 }
 NSString *fixture=[NSString stringWithContentsOfFile:@"target/workspace-native.html" encoding:NSUTF8StringEncoding error:nil];
 assert(fixture);
 [view loadHTMLString:fixture baseURL:nil];
 spin(^BOOL{return !view.loading;});
 js(view,@"cnoteTools.receive({type:'tool_state',state:{text:'hello clipboard'}});cnoteTools.show(1)");
 spin(^BOOL{return [js(view,@"!!document.querySelector('#tool-text-editor .ace_text-input')") boolValue];});
 js(view,@"ace.edit('tool-text-editor').focus()");
 [NSPasteboard.generalPasteboard clearContents];
 editKey(window,@"a",NO);js(view,@"0");editKey(window,@"c",NO);
 spin(^BOOL{return [[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] isEqualToString:@"hello clipboard"];});
 editKey(window,@"x",NO);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@""];});
 editKey(window,@"v",NO);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@"hello clipboard"];});
 editKey(window,@"z",NO);
 assert([js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@""]);
 editKey(window,@"z",YES);
 assert([js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@"hello clipboard"]);
 // Navigation must move the caret, including the reported U+001E encoding.
 js(view,@"ace.edit('tool-text-editor').setValue('first\\nsecond\\nthird',-1);ace.edit('tool-text-editor').focus()");
 cnote_workspace_test_navigation(2,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().row===1") boolValue];});
 cnote_workspace_test_navigation(1,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().column===1") boolValue];});
 cnote_workspace_test_navigation(0,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().column===0") boolValue];});
 cnote_workspace_test_navigation(3,0);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getCursorPosition().row===0") boolValue];});
 cnote_workspace_test_navigation(2,1);
 spin(^BOOL{return [js(view,@"ace.edit('tool-text-editor').getSelectedText()==='first\\n'") boolValue];});
 assert([js(view,@"ace.edit('tool-text-editor').getValue()") isEqualToString:@"first\nsecond\nthird"]);
 js(view,@"cnoteTools.show(0);cnote.receive({type:'load',id:'arrows',title:'Arrows',html:'<p>first</p><p>second</p><p>third</p>'});const editor=document.getElementById('editor');editor.focus();const range=document.createRange();range.setStart(editor.firstChild.firstChild,0);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range)");
 cnote_workspace_test_navigation(2,0);
 spin(^BOOL{return [js(view,@"getSelection().anchorNode.textContent==='second'") boolValue];});
 assert([js(view,@"document.getElementById('editor').innerHTML") isEqualToString:@"<p>first</p><p>second</p><p>third</p>"]);
 [window orderOut:nil];
}
int main(void) {
 @autoreleasepool {
  for(unsigned int i=0;i<4;i++) {
   NSString *s=[NSString stringWithFormat:@"%u",i+1];
   assert(workspaceIndex(key(s,NSEventModifierFlagCommand))==i);
   assert(workspaceIndex(key(s,NSEventModifierFlagCommand|NSEventModifierFlagCapsLock))==i);
   assert(workspaceIndex(key(s,0))==-1);
   for(NSNumber *modifier in @[@(NSEventModifierFlagControl),@(NSEventModifierFlagOption),@(NSEventModifierFlagShift)])
    assert(workspaceIndex(key(s,NSEventModifierFlagCommand|modifier.unsignedIntegerValue))==-1);
  }
  assert(workspaceIndex(key(@"5",NSEventModifierFlagCommand))==-1);
  for(NSString *s in @[@"a",@"c",@"v",@"x",@"z"]) {
   assert(editingSelector(key(s,NSEventModifierFlagCommand))!=NULL);
   assert(editingSelector(key(s,0))==NULL);
   assert(editingSelector(key(s,NSEventModifierFlagCommand|NSEventModifierFlagOption))==NULL);
  }
  assert(editingSelector(key(@"z",NSEventModifierFlagCommand|NSEventModifierFlagShift))==@selector(redo:));
  assert(editingSelector(key(@"a",NSEventModifierFlagCommand|NSEventModifierFlagShift))==NULL);
  navigationMatching();
  puts("Native workspace, editing and navigation key matching passed.");
  const char *nativeUI=getenv("CNOTE_NATIVE_UI_TESTS");
  if(nativeUI && strcmp(nativeUI,"1")==0) {
   webEditing();
   puts("WebKit editing, arrow navigation and Shift selection passed.");
  }
 }
}
