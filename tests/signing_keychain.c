// An isolated legacy-Keychain fixture: version 2 must read version 1's item
// without asking for permission. No real CNote/OneDrive credentials are used.
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#ifndef VERSION
#define VERSION 1
#endif
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    SecKeychainSetUserInteractionAllowed(false);
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(argv[1], &keychain);
    if (status) return 3;
    const char *service = "com.cyeam.cnote.signing-test";
    const char *account = "fixture";
    const char *expected = "isolated-test-data";
    if (!strcmp(argv[2], "write")) {
        status = SecKeychainAddGenericPassword(keychain, (UInt32)strlen(service), service,
            (UInt32)strlen(account), account, (UInt32)strlen(expected), expected, NULL);
    } else {
        UInt32 length = 0;
        void *data = NULL;
        status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
            (UInt32)strlen(account), account, &length, &data, NULL);
        if (!status && (length != strlen(expected) || memcmp(data, expected, length))) status = errSecDecode;
        if (data) SecKeychainItemFreeContent(NULL, data);
    }
    CFRelease(keychain);
    if (status) {
        fprintf(stderr, "Fixture version %d: Keychain status %d\n", VERSION, (int)status);
        return 1;
    }
    printf("Fixture version %d: %s passed without authentication UI\n", VERSION, argv[2]);
    return 0;
}
