#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const kPressureBridgeName;

@interface PressureBridge : NSObject <WKScriptMessageHandler>

+ (instancetype)sharedInstance;

- (void)attachToUserContentController:(WKUserContentController *)controller;
- (void)detachFromUserContentController:(WKUserContentController *)controller;

@end

NS_ASSUME_NONNULL_END
