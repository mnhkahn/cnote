#import "../src/workspace.m"
#include <assert.h>
static NSEvent *key(NSString *characters,NSEventModifierFlags flags) {
 return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:0
   windowNumber:0 context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:0];
}
int main(void) {
 @autoreleasepool {
  for(unsigned int i=0;i<4;i++) {
   NSString *s=[NSString stringWithFormat:@"%u",i+1];
   assert(workspaceIndex(key(s,NSEventModifierFlagCommand))==i);
   assert(workspaceIndex(key(s,NSEventModifierFlagCommand|NSEventModifierFlagCapsLock))==i);
   assert(workspaceIndex(key(s,0))==-1);
   for(NSNumber *modifier in @[@(NSEventModifierFlagControl),@(NSEventModifierFlagOption),@(NSEventModifierFlagShift)])
    assert(workspaceIndex(key(s,NSEventModifierFlagCommand|modifier.unsignedIntegerValue))==-1);
  }
  assert(workspaceIndex(key(@"5",NSEventModifierFlagCommand))==-1);
  puts("Native Command 1–4 matching and modifier tests passed.");
 }
}
