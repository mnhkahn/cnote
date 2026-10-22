#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static id workspaceMonitor;
static void (*workspaceCallback)(unsigned int);
static NSInteger workspaceIndex(NSEvent *event) {
    NSEventModifierFlags flags = event.modifierFlags;
    if (event.type != NSEventTypeKeyDown || !(flags & NSEventModifierFlagCommand)
        || flags & (NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift)) return -1;
    NSString *key = event.charactersIgnoringModifiers;
    if (key.length == 1 && [key characterAtIndex:0] >= '1' && [key characterAtIndex:0] <= '4')
        return [key characterAtIndex:0] - '1';
    return -1;
}
static WKWebView *focusedWebView(NSEvent *event) {
    if (!event.window || event.window != NSApp.mainWindow) return nil;
    NSResponder *responder = event.window.firstResponder;
    if (![responder isKindOfClass:NSView.class]) return nil;
    for (NSView *view = (NSView *)responder; view; view = view.superview) {
        if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
    }
    return nil;
}
// Normalize arrows by their physical key codes before forwarding to WebKit.
// Control characters such as U+001E must never become editor text.
static NSEvent *navigationEvent(NSEvent *event) {
    if (event.type != NSEventTypeKeyDown) return event;
    unichar character;
    switch (event.keyCode) {
        case 123: character = NSLeftArrowFunctionKey; break;
        case 124: character = NSRightArrowFunctionKey; break;
        case 125: character = NSDownArrowFunctionKey; break;
        case 126: character = NSUpArrowFunctionKey; break;
        default: return event;
    }
    NSString *key = [NSString stringWithCharacters:&character length:1];
    if ([event.characters isEqualToString:key] && [event.charactersIgnoringModifiers isEqualToString:key]) return event;
    return [NSEvent keyEventWithType:event.type location:event.locationInWindow
        modifierFlags:event.modifierFlags timestamp:event.timestamp windowNumber:event.windowNumber
        context:nil characters:key charactersIgnoringModifiers:key isARepeat:event.isARepeat keyCode:event.keyCode];
}
// Native clipboard actions emit the clipboard events used by DOM editors.
// Selection and history also need the active code editor's own document model.
static SEL editingSelector(NSEvent *event) {
    NSEventModifierFlags flags = event.modifierFlags;
    if (event.type != NSEventTypeKeyDown || !(flags & NSEventModifierFlagCommand)
        || flags & (NSEventModifierFlagControl | NSEventModifierFlagOption)) return NULL;
    NSString *key = event.charactersIgnoringModifiers.lowercaseString;
    if ([key isEqualToString:@"z"])
        return flags & NSEventModifierFlagShift ? @selector(redo:) : @selector(undo:);
    if (flags & NSEventModifierFlagShift) return NULL;
    if ([key isEqualToString:@"a"]) return @selector(selectAll:);
    if ([key isEqualToString:@"c"]) return @selector(copy:);
    if ([key isEqualToString:@"v"]) return @selector(paste:);
    if ([key isEqualToString:@"x"]) return @selector(cut:);
    return NULL;
}
static BOOL forwardEditingKey(NSEvent *event) {
    SEL selector = editingSelector(event);
    WKWebView *view = selector ? focusedWebView(event) : nil;
    if (!view) return NO;
    if (selector == @selector(selectAll:) || selector == @selector(undo:) || selector == @selector(redo:)) {
        NSString *command = selector == @selector(selectAll:) ? @"selectAll" : selector == @selector(undo:) ? @"undo" : @"redo";
        NSString *script = [NSString stringWithFormat:@"window.cnoteTools&&cnoteTools.workspace?cnoteTools.edit('%@'):document.execCommand('%@')", command, command];
        [view evaluateJavaScript:script completionHandler:nil];
        return YES;
    }
    return [NSApp sendAction:selector to:nil from:event];
}

int cnote_workspace_install(void (*callback)(unsigned int)) {
    if (![NSThread isMainThread]) return 0;
    workspaceCallback = callback;
    if (!workspaceMonitor) {
        workspaceMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
            NSInteger index = workspaceIndex(event);
            if (index >= 0 && event.window && event.window == NSApp.mainWindow && workspaceCallback) {
                workspaceCallback((unsigned int)index);
                return nil; // Consume before WKWebView or a code editor handles Command-number.
            }
            if (forwardEditingKey(event)) return nil;
            return focusedWebView(event) ? navigationEvent(event) : event;
        }];
    }
    return workspaceMonitor != nil;
}
// The smoke test posts real Cocoa key events while WKWebView is first responder.
void cnote_workspace_test_key(unsigned int index) {
    if (index > 3 || !NSApp.mainWindow) return;
    NSString *key = [NSString stringWithFormat:@"%u", index + 1];
    unsigned short codes[] = {18,19,20,21};
    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:NSEventModifierFlagCommand timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:NSApp.mainWindow.windowNumber context:nil characters:key
        charactersIgnoringModifiers:key isARepeat:NO keyCode:codes[index]];
    [NSApp postEvent:event atStart:NO];
}

void cnote_workspace_test_navigation(unsigned int index, int shift) {
    if (index > 3 || !NSApp.mainWindow) return;
    unichar characters[] = {NSLeftArrowFunctionKey, NSRightArrowFunctionKey, NSDownArrowFunctionKey, NSUpArrowFunctionKey};
    unsigned short codes[] = {123,124,125,126};
    NSString *key = [NSString stringWithCharacters:&characters[index] length:1];
    if (index == 2) key = @"\x1e"; // Reproduce the reported control-character event.
    NSEventModifierFlags flags = NSEventModifierFlagFunction | NSEventModifierFlagNumericPad;
    if (shift) flags |= NSEventModifierFlagShift;
    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:NSApp.mainWindow.windowNumber context:nil characters:key
        charactersIgnoringModifiers:key isARepeat:NO keyCode:codes[index]];
    [NSApp postEvent:event atStart:NO];
}
