#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

int cnote_copy_image(const unsigned char *bytes, size_t length, const char *html) {
    if (![NSThread isMainThread] || !bytes || !length || !html) return 0;
    NSData *data = [NSData dataWithBytes:bytes length:length];
    NSImage *image = [[NSImage alloc] initWithData:data];
    if (!image) return 0;
    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *markup = [NSString stringWithUTF8String:html];
    if (!png || !markup) return 0;
    NSPasteboardItem *item = [[NSPasteboardItem alloc] init];
    [item setData:png forType:NSPasteboardTypePNG];
    [item setString:markup forType:NSPasteboardTypeHTML];
    [NSPasteboard.generalPasteboard clearContents];
    return [NSPasteboard.generalPasteboard writeObjects:@[item]] ? 1 : 0;
}

extern void cnote_theme_attach_menu(NSMenu *menu);

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
// Wry's child webview overrides performKeyEquivalent: to always return NO.
// Give WebKit's implementation the arrow before GPUI's text input machinery.
static BOOL forwardNavigationKey(NSEvent *event) {
    if (event.keyCode < 123 || event.keyCode > 126) return NO;
    WKWebView *view = focusedWebView(event);
    if (!view) return NO;
    SEL selector = @selector(performKeyEquivalent:);
    BOOL (*perform)(id, SEL, NSEvent *) = (void *)[WKWebView instanceMethodForSelector:selector];
    return perform(view, selector, navigationEvent(event));
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
            if (forwardEditingKey(event) || forwardNavigationKey(event)) return nil;
            return focusedWebView(event) ? navigationEvent(event) : event;
        }];
    }
    return workspaceMonitor != nil;
}

// Copy the application's menu items so their checked states and GPUI actions
// stay identical in both entry points. Cocoa draws above the child WKWebView.
static NSMenu *workspaceMoreMenu(void) {
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"更多"];
    NSMenuItem *theme = [[NSApp.mainMenu itemWithTitle:@"视图"].submenu itemWithTitle:@"主题"];
    if (theme) {
        NSMenuItem *copy = [theme copy];
        // A detached popup has no main-menu responder-chain context.
        for (NSMenuItem *item in copy.submenu.itemArray) item.target = NSApp.delegate;
        cnote_theme_attach_menu(copy.submenu);
        [menu addItem:copy];
    }
    NSMenuItem *update = [[NSApp.mainMenu itemWithTitle:@"窗口"].submenu itemWithTitle:@"检查更新…"];
    if (update) {
        [menu addItem:NSMenuItem.separatorItem];
        NSMenuItem *copy = [update copy];
        copy.target = NSApp.delegate;
        [menu addItem:copy];
    }
    return menu;
}
void cnote_workspace_show_more_menu(void) {
    NSWindow *window = NSApp.mainWindow;
    if (!window) return;
    NSPoint location = [window.contentView convertPoint:window.mouseLocationOutsideOfEventStream fromView:nil];
    // Run outside GPUI and the main dispatch queue. Its queue must remain free
    // to render live previews while AppKit runs the nested menu tracking loop.
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode, ^{
        if (!window.visible) return;
        [workspaceMoreMenu() popUpMenuPositioningItem:nil atLocation:location inView:window.contentView];
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
}
// Exercise the copied menu's actual GPUI action without opening a blocking popup.
void cnote_workspace_test_more_menu(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSMenu *theme = [workspaceMoreMenu() itemWithTitle:@"主题"].submenu;
        NSCAssert([theme itemWithTitle:@"深色"] != nil, @"Missing theme menu");
        NSMenuItem *item = [theme itemWithTitle:@"深色"];
        BOOL dispatched = [NSApp sendAction:item.action to:item.target from:item];
        NSCAssert(dispatched, @"Theme menu action must reach GPUI");
    });
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
    NSEventModifierFlags flags = NSEventModifierFlagFunction | NSEventModifierFlagNumericPad;
    if (shift) flags |= NSEventModifierFlagShift;
    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:NSApp.mainWindow.windowNumber context:nil characters:key
        charactersIgnoringModifiers:key isARepeat:NO keyCode:codes[index]];
    [NSApp postEvent:event atStart:NO];
}
