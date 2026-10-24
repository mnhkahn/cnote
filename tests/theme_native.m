#import "../src/theme.m"
#include <assert.h>

static int lastPreview = -99;
static BOOL tracking;
static BOOL previewWhileTracking;
static NSMenu *trackingMenu;
static void capture(int index) {
    lastPreview = index;
    if (tracking && index == 2) {
        previewWhileTracking = YES;
        [trackingMenu cancelTracking];
    }
}
static void drain(void) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
}
@interface OriginalMenuDelegate : NSObject <NSMenuDelegate>
@property NSInteger opens;
@property NSInteger closes;
@property NSInteger highlights;
@end
@implementation OriginalMenuDelegate
- (void)menuWillOpen:(NSMenu *)menu { self.opens++; }
- (void)menuDidClose:(NSMenu *)menu { self.closes++; }
- (void)menu:(NSMenu *)menu willHighlightItem:(NSMenuItem *)item { self.highlights++; }
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSMenu *root = [NSMenu new], *view = [NSMenu new], *themes = [NSMenu new];
        NSMenuItem *viewItem = [[NSMenuItem alloc] initWithTitle:@"视图" action:nil keyEquivalent:@""];
        NSMenuItem *themeItem = [[NSMenuItem alloc] initWithTitle:@"主题" action:nil keyEquivalent:@""];
        viewItem.submenu = view; themeItem.submenu = themes;
        [root addItem:viewItem]; [view addItem:themeItem];
        themes.autoenablesItems = NO;
        for (NSString *label in @[@"跟随系统", @"浅色", @"深色"]) {
            NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:label action:nil keyEquivalent:@""];
            item.enabled = YES;
            [themes addItem:item];
        }
        OriginalMenuDelegate *original = [OriginalMenuDelegate new];
        themes.delegate = original;
        NSApp.mainMenu = root;
        cnote_theme_install("[\"跟随系统\",\"浅色\",\"深色\"]", capture);
        id<NSMenuDelegate> proxy = themes.delegate;
        cnote_theme_refresh_menu();
        assert(themes.delegate == proxy); // Reattaching is idempotent.
        [proxy menuWillOpen:themes]; assert(original.opens == 1);
        [proxy menu:themes willHighlightItem:themes.itemArray[1]];
        assert(lastPreview == -99); // Updates run after the delegate releases its borrow.
        drain(); assert(lastPreview == 1 && original.highlights == 1);
        [proxy menu:themes willHighlightItem:nil]; drain(); assert(lastPreview == -1);
        [proxy menuDidClose:themes]; drain(); assert(original.closes == 1 && lastPreview == -1);
        NSMenu *copy = [themes copy]; cnote_theme_attach_menu(copy);
        assert(copy.delegate != themes.delegate);
        [copy.delegate menuWillOpen:copy]; assert(original.opens == 2);
        [copy.delegate menu:copy willHighlightItem:copy.itemArray[2]];
        drain(); assert(lastPreview == 2);
        [copy.delegate menuDidClose:copy]; drain(); assert(lastPreview == -1 && original.closes == 2);

        // A real AppKit tracking loop must process a preview before the popup closes.
        // Enter it from the run loop, keeping the main dispatch queue free to render.
        __block BOOL finished = NO;
        CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode, ^{
            tracking = YES; trackingMenu = copy;
            NSDate *trackingDeadline = [NSDate dateWithTimeIntervalSinceNow:3];
            NSTimer *timer = [NSTimer timerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
                if (trackingDeadline.timeIntervalSinceNow <= 0) { [copy cancelTracking]; return; }
                [copy.delegate menu:copy willHighlightItem:copy.itemArray[2]];
            }];
            [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
            [copy popUpMenuPositioningItem:nil atLocation:NSMakePoint(300, 300) inView:nil];
            [timer invalidate]; tracking = NO; trackingMenu = nil; finished = YES;
        });
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
        while (!finished && deadline.timeIntervalSinceNow > 0) drain();
        assert(finished && previewWhileTracking);
        drain(); assert(lastPreview == -1);
        puts("Native theme highlight, cancellation, delegate forwarding, copied menus and live menu tracking passed.");
    }
}
