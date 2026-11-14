#import "../src/theme.m"
#import "../src/workspace.m"
#include <assert.h>
int main(void) {
 @autoreleasepool {
  NSPasteboard *pasteboard=NSPasteboard.generalPasteboard;
  NSMutableArray *previous=[NSMutableArray array];
  for(NSPasteboardItem *item in pasteboard.pasteboardItems) {
   NSPasteboardItem *saved=[[NSPasteboardItem alloc] init];
   for(NSPasteboardType type in item.types) {NSData *data=[item dataForType:type];if(data)[saved setData:data forType:type];}
   [previous addObject:saved];
  }
  @try {
   NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:2 pixelsHigh:3 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:8 bitsPerPixel:32];
   memset(bitmap.bitmapData,255,bitmap.bytesPerRow*bitmap.pixelsHigh);
   NSData *source=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
   const char *html="<img src=\"data:image/png;base64,test\" alt=\"test image\">";
   assert(cnote_copy_image(source.bytes,source.length,html));
   NSData *png=[pasteboard dataForType:NSPasteboardTypePNG];
   NSBitmapImageRep *result=[NSBitmapImageRep imageRepWithData:png];
   assert(result.pixelsWide==2 && result.pixelsHigh==3);
   assert([[pasteboard stringForType:NSPasteboardTypeHTML] isEqualToString:[NSString stringWithUTF8String:html]]);
   NSInteger unchanged=pasteboard.changeCount;
   const unsigned char invalid[]={1,2,3};
   assert(!cnote_copy_image(invalid,sizeof(invalid),html));
   assert(pasteboard.changeCount==unchanged);
   NSString *directory=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
   assert([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]);
   NSString *file=[directory stringByAppendingPathComponent:@"文件.txt"];
   assert([@"downloaded" writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil]);
   NSData *paths=[NSJSONSerialization dataWithJSONObject:@[file] options:0 error:nil];
   NSString *json=[[NSString alloc] initWithData:paths encoding:NSUTF8StringEncoding];
   assert(cnote_copy_files(json.UTF8String));
   NSArray *urls=[pasteboard readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
   assert(urls.count==1 && [[urls[0] path] isEqualToString:file]);
   unchanged=pasteboard.changeCount;
   assert(!cnote_copy_files("[\"/nonexistent-cnote-file\"]"));
   assert(pasteboard.changeCount==unchanged);
   [NSFileManager.defaultManager removeItemAtPath:directory error:nil];
   puts("Native file clipboard: file URLs and failure preservation passed.");
   puts("Native image clipboard: PNG pixels, HTML representation, and failure preservation passed.");
  } @finally {
   [pasteboard clearContents];if(previous.count)[pasteboard writeObjects:previous];
  }
 }
}
