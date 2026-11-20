#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

@interface CNoteNotifications : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation CNoteNotifications
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
               UNNotificationPresentationOptionSound);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"cnote://tool/trello"]];
    });
    completion();
}
@end

static UNUserNotificationCenter *CNoteCenter(void) {
    // Command-line tests are not app bundles; UserNotifications would throw.
    if (![[NSBundle mainBundle].bundlePath hasSuffix:@".app"]) return nil;
    static CNoteNotifications *delegate;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        delegate = [CNoteNotifications new];
        [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
    });
    return [UNUserNotificationCenter currentNotificationCenter];
}
void cnote_notifications_install(void) {
    (void)CNoteCenter();
}
void cnote_notifications_prepare(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [CNoteCenter() requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                                   completionHandler:^(BOOL granted, NSError *error) {
            (void)granted;
            if (error) NSLog(@"CNote notification authorization failed: %@", error);
        }];
    });
}
void cnote_notification_send(const char *identifier, const char *title, const char *body) {
    NSString *key = [NSString stringWithUTF8String:identifier];
    NSString *heading = [NSString stringWithUTF8String:title];
    NSString *text = [NSString stringWithUTF8String:body];
    dispatch_async(dispatch_get_main_queue(), ^{
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = heading;
        content.body = text;
        content.sound = [UNNotificationSound defaultSound];
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:key content:content trigger:nil];
        [CNoteCenter() addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            if (error) NSLog(@"CNote notification delivery failed: %@", error);
        }];
    });
}
