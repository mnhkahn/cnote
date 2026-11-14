#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// This is a one-time offer for this feature, not a prompt on every release.
static NSString *const offerKey = @"CNoteTextFileDefaultsOfferVersion";
static BOOL offerScheduled;
static BOOL shouldOfferTextDefaults(NSBundle *bundle, NSUserDefaults *defaults) {
    return [bundle.bundleURL.pathExtension isEqualToString:@"app"] &&
        [bundle.bundleIdentifier isEqualToString:@"com.cyeam.cnote"] &&
        [bundle objectForInfoDictionaryKey:@"CFBundleDocumentTypes"] != nil &&
        [defaults integerForKey:offerKey] < 1;
}

static void setTextDefaults(NSURL *application, NSArray<UTType *> *types, NSUInteger index,
                            NSMutableArray<NSString *> *failures, NSWindow *window) {
    if (index == types.count) {
        if (failures.count && window.visible && !window.attachedSheet) {
            NSAlert *alert = [NSAlert new];
            alert.messageText = @"部分默认打开方式未更改";
            alert.informativeText = @"macOS 未完成部分文件类型的设置（可能已取消系统确认）。这些类型会继续使用原先的默认应用。";
            [alert addButtonWithTitle:@"知道了"];
            [alert beginSheetModalForWindow:window completionHandler:nil];
        }
        return;
    }
    UTType *type = types[index];
    // Only ask the OS for types that are not already assigned to this app.
    NSURL *current;
    if (@available(macOS 12.0, *)) {
        current = [NSWorkspace.sharedWorkspace URLForApplicationToOpenContentType:type];
    } else {
        current = CFBridgingRelease(LSCopyDefaultApplicationURLForContentType(
            (__bridge CFStringRef)type.identifier, kLSRolesAll, NULL));
    }
    if ([current.URLByResolvingSymlinksInPath isEqual:application.URLByResolvingSymlinksInPath]) {
        setTextDefaults(application, types, index + 1, failures, window);
        return;
    }
    if (@available(macOS 12.0, *)) {
        [NSWorkspace.sharedWorkspace setDefaultApplicationAtURL:application toOpenContentType:type
            completionHandler:^(NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (error) [failures addObject:type.identifier];
                    // A cancelled system confirmation ends the request; do not open more prompts.
                    if (([error.domain isEqualToString:NSOSStatusErrorDomain] && error.code == -128) ||
                        ([error.domain isEqualToString:NSCocoaErrorDomain] &&
                         [error.userInfo[NSUnderlyingErrorKey] code] == -128)) {
                        setTextDefaults(application, types, types.count, failures, window);
                    } else {
                        setTextDefaults(application, types, index + 1, failures, window);
                    }
                });
            }];
    } else {
        NSString *identifier = [NSBundle bundleWithURL:application].bundleIdentifier;
        OSStatus status = identifier ? LSSetDefaultRoleHandlerForContentType(
            (__bridge CFStringRef)type.identifier, kLSRolesAll, (__bridge CFStringRef)identifier) : paramErr;
        if (status != noErr) [failures addObject:type.identifier];
        setTextDefaults(application, types, status == userCanceledErr ? types.count : index + 1, failures, window);
    }
}

void cnote_default_apps_offer(void) {
    if (![NSThread isMainThread] || offerScheduled) return;
    NSBundle *bundle = NSBundle.mainBundle;
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    if (!shouldOfferTextDefaults(bundle, defaults)) return;
    offerScheduled = YES;
    // Present after the editor's startup callback has returned to Cocoa.
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode, ^{
        NSWindow *window = NSApp.mainWindow;
        if (!window.visible || window.attachedSheet) return;
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"用 CNote 默认打开文本文件？";
        alert.informativeText = @"CNote 现已支持打开 Markdown、TXT、JSON、日志和配置文件等文本。设为默认后，双击这些文件会进入 CNote 的“文本”页。网页文件的打开方式不受影响。macOS 可能会继续请求系统确认。";
        [alert addButtonWithTitle:@"设为默认"];
        [alert addButtonWithTitle:@"暂不设置"];
        [alert beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) {
            [defaults setInteger:1 forKey:offerKey];
            if (response != NSAlertFirstButtonReturn) return;
            NSArray *extensions = @[@"md", @"markdown", @"mdown", @"mkd", @"txt", @"text", @"log",
                @"json", @"jsonl", @"ndjson", @"yaml", @"yml", @"toml", @"ini", @"conf",
                @"csv", @"tsv", @"xml", @"sql"];
            NSMutableArray<UTType *> *types = [NSMutableArray array];
            for (NSString *extension in extensions) {
                UTType *type = [UTType typeWithFilenameExtension:extension conformingToType:UTTypeData];
                if (type && ![types containsObject:type]) [types addObject:type];
            }
            // Let the initial sheet close before macOS presents its confirmation.
            dispatch_async(dispatch_get_main_queue(), ^{
                setTextDefaults(bundle.bundleURL, types, 0, [NSMutableArray array], window);
            });
        }];
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
}
