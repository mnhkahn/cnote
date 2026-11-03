// Exercises startup gating without showing UI or modifying real file associations.
#import "../src/default_apps.m"
#include <assert.h>
int main(void) { @autoreleasepool {
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString *app = [root stringByAppendingPathComponent:@"CNote.app"];
    NSString *contents = [app stringByAppendingPathComponent:@"Contents"];
    assert([[NSFileManager defaultManager] createDirectoryAtPath:contents withIntermediateDirectories:YES attributes:nil error:nil]);
    NSDictionary *info = @{@"CFBundleIdentifier":@"com.cyeam.cnote", @"CFBundleVersion":@"1.2.3", @"CFBundleDocumentTypes":@[@{}]};
    assert([info writeToFile:[contents stringByAppendingPathComponent:@"Info.plist"] atomically:YES]);
    NSBundle *bundle = [NSBundle bundleWithPath:app];
    NSString *suite = [@"com.cyeam.cnote.test." stringByAppendingString:NSUUID.UUID.UUIDString];
    NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:suite];
    assert(shouldOfferTextDefaults(bundle, defaults));
    assert(!shouldOfferTextDefaults(NSBundle.mainBundle, defaults));
    // Both accepting and declining record the feature version. A later app version
    // must not turn the one-time decision into a recurring update prompt.
    [defaults setInteger:1 forKey:offerKey];
    assert(!shouldOfferTextDefaults(bundle, defaults));
    [defaults removePersistentDomainForName:suite];
    assert(shouldOfferTextDefaults(bundle, defaults));
    // Resolve each requested file type using macOS's data-conforming UTI path.
    for (NSString *ext in @[@"md",@"txt",@"json",@"toml",@"ini",@"sql"]) {
        UTType *type = [UTType typeWithFilenameExtension:ext conformingToType:UTTypeData];
        assert(type && [type conformsToType:UTTypeData]);
    }
    [defaults removePersistentDomainForName:suite];
    [[NSFileManager defaultManager] removeItemAtPath:root error:nil];
    puts("Default-app offer gating and text type resolution passed; no UI or associations changed.");
} return 0; }
