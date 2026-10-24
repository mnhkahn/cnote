#import <AppKit/AppKit.h>
#import <objc/runtime.h>

static void (*themePreviewCallback)(int);
static NSArray<NSString *> *themeLabels;
static char themeDelegateKey;
static void previewTheme(int index) {
    // Common modes include AppKit menu tracking. Run outside the delegate call
    // so GPUI has no outstanding mutable borrow when Rust updates the window.
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{
        if (themePreviewCallback) themePreviewCallback(index);
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
}

// Forward GPUI's menu validation/open hooks while adding live previews.
// Each menu retains its proxy because NSMenu.delegate itself is weak.
@interface CNoteThemeMenuDelegate : NSObject <NSMenuDelegate>
@property(nonatomic, weak) id<NSMenuDelegate> original;
@end
@implementation CNoteThemeMenuDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector {
    if ([self.original respondsToSelector:selector]) return self.original;
    return [super forwardingTargetForSelector:selector];
}
- (void)menu:(NSMenu *)menu willHighlightItem:(NSMenuItem *)item {
    NSInteger index = item ? [themeLabels indexOfObject:item.title] : NSNotFound;
    previewTheme(index == NSNotFound ? -1 : (int)index);
    if ([self.original respondsToSelector:_cmd]) [self.original menu:menu willHighlightItem:item];
}
- (void)menuDidClose:(NSMenu *)menu {
    // Never rebuild a menu here: AppKit is still finishing its tracking session.
    previewTheme(-1);
    if ([self.original respondsToSelector:_cmd]) [self.original menuDidClose:menu];
}
@end

void cnote_theme_attach_menu(NSMenu *menu) {
    if (!menu || !themeLabels) return;
    CNoteThemeMenuDelegate *proxy = objc_getAssociatedObject(menu, &themeDelegateKey);
    if (proxy && menu.delegate == proxy) return;
    proxy = [CNoteThemeMenuDelegate new];
    id<NSMenuDelegate> original = menu.delegate;
    // NSMenu copies may inherit a source menu's proxy delegate.
    if ([(id)original isKindOfClass:CNoteThemeMenuDelegate.class])
        original = ((CNoteThemeMenuDelegate *)original).original;
    proxy.original = original;
    objc_setAssociatedObject(menu, &themeDelegateKey, proxy, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    menu.delegate = proxy;
}

void cnote_theme_refresh_menu(void) {
    NSMenu *menu = [[NSApp.mainMenu itemWithTitle:@"视图"].submenu itemWithTitle:@"主题"].submenu;
    cnote_theme_attach_menu(menu);
}

void cnote_theme_install(const char *labelsJSON, void (*callback)(int)) {
    NSCAssert(NSThread.isMainThread, @"Theme previews require the main thread");
    NSData *data = [[NSString stringWithUTF8String:labelsJSON] dataUsingEncoding:NSUTF8StringEncoding];
    themeLabels = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    themePreviewCallback = callback;
    cnote_theme_refresh_menu();
}

// Exercise both actual menu delegate paths without a blocking interactive menu.
void cnote_theme_test_preview(int index, int copied) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSMenu *menu = [[NSApp.mainMenu itemWithTitle:@"视图"].submenu itemWithTitle:@"主题"].submenu;
        if (copied) menu = [menu copy];
        cnote_theme_attach_menu(menu);
        NSCAssert(menu.delegate != nil, @"Theme delegate must be attached");
        if (index < 0) {
            [menu.delegate menuDidClose:menu];
        } else {
            NSMenuItem *item = [menu itemWithTitle:themeLabels[(NSUInteger)index]];
            NSCAssert(item != nil, @"Missing preview theme");
            [menu.delegate menu:menu willHighlightItem:item];
        }
    });
}
