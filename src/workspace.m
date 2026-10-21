#import <AppKit/AppKit.h>

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
            return event;
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
