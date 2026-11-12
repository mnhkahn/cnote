#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <Security/Security.h>
#include <stdint.h>
#include <string.h>

// Each image export owns a fresh panel and keeps it alive until its callback.
// Schedule presentation outside GPUI's update and attach it to the main window.
static NSSavePanel *imageSavePanel;
static BOOL imageSavePending = NO;
int cnote_image_save_prompt(const char *directory, const char *name, void *context,
                           void (*callback)(void *, int, const char *)) {
    if (![NSThread isMainThread] || imageSavePending || !directory || !name || !callback) return 0;
    NSWindow *parent = NSApp.mainWindow;
    if (!parent || !parent.visible || parent.attachedSheet) return 0;
    NSString *folder = [NSString stringWithUTF8String:directory];
    NSString *filename = [NSString stringWithUTF8String:name];
    if (!folder || !filename) return 0;
    imageSavePending = YES;
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode, ^{
        __block BOOL completed = NO;
        void (^finish)(int, const char *) = ^(int status, const char *path) {
            if (completed) return;
            completed = YES;
            imageSavePanel = nil;
            imageSavePending = NO;
            NSLog(@"CNote image save panel: %@", status == 1 ? @"selected" : status == 0 ? @"cancelled" : @"failed");
            callback(context, status, path);
        };
        @try {
            if (!parent.visible || parent.attachedSheet) { finish(-1, NULL); return; }
            imageSavePanel = [[NSSavePanel alloc] init];
            imageSavePanel.directoryURL = [NSURL fileURLWithPath:folder isDirectory:YES];
            imageSavePanel.nameFieldStringValue = filename;
            imageSavePanel.canCreateDirectories = YES;
            [imageSavePanel beginSheetModalForWindow:parent completionHandler:^(NSModalResponse response) {
                NSURL *url = imageSavePanel.URL;
                if (response == NSModalResponseOK && url.isFileURL) {
                    finish(1, url.fileSystemRepresentation);
                } else {
                    finish(response == NSModalResponseCancel ? 0 : -1, NULL);
                }
            }];
            NSLog(@"CNote image save panel: presented");
        } @catch (NSException *exception) {
            // Do not log file names, paths, or exception userInfo.
            NSLog(@"CNote image save panel: presentation exception");
            finish(-1, NULL);
        }
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
    return 1;
}

// Keep the file alive until the picker is dismissed or the selected service
// has finished reading it, including while AirDrop waits for a recipient.
@interface CNoteImageShare : NSObject <NSSharingServicePickerDelegate, NSSharingServiceDelegate>
@property(nonatomic, strong) NSSharingServicePicker *picker;
@property(nonatomic, weak) NSView *anchor;
@property(nonatomic) NSRect anchorRect;
@property(nonatomic, copy) void (^completion)(int);
- (void)finish:(int)status;
@end

static CNoteImageShare *imageShare;

@implementation CNoteImageShare
- (void)finish:(int)status {
    void (^completion)(int) = self.completion;
    self.completion = nil;
    if (!completion) return;
    // Leave AppKit's delegate stack before releasing the picker and file.
    dispatch_async(dispatch_get_main_queue(), ^{
        imageShare = nil;
        completion(status);
    });
}
- (void)sharingServicePicker:(NSSharingServicePicker *)picker didChooseSharingService:(NSSharingService *)service {
    if (!service) [self finish:0];
}
- (id<NSSharingServiceDelegate>)sharingServicePicker:(NSSharingServicePicker *)picker delegateForSharingService:(NSSharingService *)service {
    return self;
}
- (NSView *)anchoringViewForSharingService:(NSSharingService *)service showRelativeToRect:(NSRect *)rect preferredEdge:(NSRectEdge *)edge {
    *rect = self.anchorRect;
    *edge = NSMinYEdge;
    return self.anchor;
}
- (void)sharingService:(NSSharingService *)service didShareItems:(NSArray *)items {
    [self finish:1];
}
- (void)sharingService:(NSSharingService *)service didFailToShareItems:(NSArray *)items error:(NSError *)error {
    [self finish:[error.domain isEqualToString:NSCocoaErrorDomain] && error.code == NSUserCancelledError ? 0 : -1];
}
@end

int cnote_image_share(const char *path, void *context, void (*callback)(void *, int)) {
    if (!NSThread.isMainThread || imageShare) return 0;
    NSWindow *window = NSApp.mainWindow;
    NSView *view = window.contentView;
    NSString *filename = [NSString stringWithUTF8String:path];
    if (!view || !window.visible || !filename) return 0;

    CNoteImageShare *share = [CNoteImageShare new];
    share.anchor = view;
    NSRect bounds = view.bounds;
    NSPoint point = [view convertPoint:window.mouseLocationOutsideOfEventStream fromView:nil];
    if (!NSPointInRect(point, bounds)) point = NSMakePoint(NSMidX(bounds), NSMaxY(bounds) - 36);
    share.anchorRect = NSMakeRect(point.x, point.y, 1, 1);
    share.completion = ^(int status) { callback(context, status); };
    imageShare = share;

    NSURL *file = [NSURL fileURLWithPath:filename isDirectory:NO];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!window.visible || window.attachedSheet) { [share finish:-1]; return; }
        share.picker = [[NSSharingServicePicker alloc] initWithItems:@[file]];
        share.picker.delegate = share;
        [share.picker showRelativeToRect:share.anchorRect ofView:view preferredEdge:NSMinYEdge];
    });
    return 1;
}

// Update the existing item without asking Security.framework to return its
// old secret. keyring's set_password performs a second password read first.
int32_t cnote_keychain_write(const char *service, const char *account,
                            const unsigned char *bytes, size_t length) {
    if (!service || !account || !bytes || length > UINT32_MAX) return errSecParam;
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainCopyDefault(&keychain);
    if (status != errSecSuccess) return status;
    SecKeychainItemRef item = NULL;
    status = SecKeychainFindGenericPassword(keychain,
        (UInt32)strlen(service), service, (UInt32)strlen(account), account,
        NULL, NULL, &item);
    if (status == errSecSuccess) {
        status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)length, bytes);
    } else if (status == errSecItemNotFound) {
        status = SecKeychainAddGenericPassword(keychain,
            (UInt32)strlen(service), service, (UInt32)strlen(account), account,
            (UInt32)length, bytes, NULL);
    }
    if (item) CFRelease(item);
    CFRelease(keychain);
    return status;
}

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
    if (key.length == 1 && [key characterAtIndex:0] >= '1' && [key characterAtIndex:0] <= '5')
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
    if ([key isEqualToString:@"b"]) return @selector(toggleBoldface:);
    if ([key isEqualToString:@"i"]) return @selector(toggleItalics:);
    if ([key isEqualToString:@"u"]) return @selector(toggleUnderline:);
    return NULL;
}
static NSString *noteCommand(NSEvent *event) {
    NSEventModifierFlags flags = event.modifierFlags;
    if (event.type != NSEventTypeKeyDown || !(flags & NSEventModifierFlagCommand) || (flags & NSEventModifierFlagControl)) return nil;
    NSString *key = event.charactersIgnoringModifiers.lowercaseString;
    // Shift/Option can change the characters of number and punctuation keys.
    switch (event.keyCode) {
        case 18: key = @"1"; break; case 19: key = @"2"; break; case 20: key = @"3"; break;
        case 29: key = @"0"; break; case 26: key = @"7"; break; case 28: key = @"8"; break; case 25: key = @"9"; break;
        case 33: key = @"["; break; case 30: key = @"]"; break; case 42: key = @"\\"; break; case 44: key = @"/"; break;
        case 17: if (flags & NSEventModifierFlagOption) key = @"t"; break;
    }
    NSString *chord = [NSString stringWithFormat:@"%@%@%@", flags & NSEventModifierFlagShift ? @"shift-" : @"", flags & NSEventModifierFlagOption ? @"alt-" : @"", key];
    return @{@"b":@"bold", @"i":@"italic", @"u":@"underline", @"shift-x":@"strikeThrough",
        @"e":@"inlineCode", @"shift-c":@"codeBlock", @"k":@"link", @"shift-k":@"unlink",
        @"alt-0":@"paragraph", @"alt-1":@"heading1", @"alt-2":@"heading2", @"alt-3":@"heading3",
        @"shift-7":@"insertOrderedList", @"shift-8":@"insertUnorderedList", @"shift-9":@"task", @"shift-b":@"quote",
        @"[":@"outdent", @"]":@"indent", @"shift-\\":@"removeFormat",
        @"shift-l":@"justifyLeft", @"shift-e":@"justifyCenter", @"shift-r":@"justifyRight", @"shift-j":@"justifyFull",
        @"alt-t":@"table", @"shift-v":@"pastePlain", @"f":@"find", @"g":@"findNext", @"shift-g":@"findPrevious", @"p":@"print", @"/":@"shortcuts"}[chord];
}
static BOOL forwardEditingKey(NSEvent *event) {
    NSString *note = noteCommand(event);
    SEL selector = editingSelector(event);
    WKWebView *view = (selector || note) ? focusedWebView(event) : nil;
    if (!view) return NO;
    if (note) {
        // Wry does not deliver these Command equivalents to the DOM reliably.
        // The editor checks focus, dialogs and workspace before formatting.
        if ([note isEqualToString:@"pastePlain"]) {
            NSString *text = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] ?: @"";
            NSData *data = [NSJSONSerialization dataWithJSONObject:@[text] options:0 error:nil];
            NSString *args = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            NSString *script = [NSString stringWithFormat:@"!!(window.cnote&&cnote.pastePlain(...%@))", args];
            [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
                if (!error && ![result boolValue]) [NSApp sendAction:@selector(pasteAsPlainText:) to:nil from:event];
            }];
            return YES;
        }
        NSString *script = [NSString stringWithFormat:@"!!(window.cnote&&cnote.formatShortcut('%@'))", note];
        [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
            // Keep code-editor and text-field shortcuts working outside note content.
            if (!error && ![result boolValue] && focusedWebView(event) == view) {
                SEL equivalent = @selector(performKeyEquivalent:);
                BOOL (*perform)(id, SEL, NSEvent *) = (void *)[WKWebView instanceMethodForSelector:equivalent];
                if (!perform(view, equivalent, event)) [view.window.firstResponder keyDown:event];
            }
        }];
        return YES;
    }
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
    if (index > 4 || !NSApp.mainWindow) return;
    NSString *key = [NSString stringWithFormat:@"%u", index + 1];
    unsigned short codes[] = {18,19,20,21,23};
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
