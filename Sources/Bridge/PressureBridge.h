#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const kPressureBridgeName;

@interface PressureBridge : NSObject <WKScriptMessageHandler>

+ (instancetype)sharedInstance;

- (void)attachToUserContentController:(WKUserContentController *)controller;
- (void)attachToUserContentController:(WKUserContentController *)controller inWorld:(nullable id)world;
- (void)detachFromUserContentController:(WKUserContentController *)controller;

- (void)registerWebView:(WKWebView *)webView;
- (void)broadcastJavaScript:(NSString *)js;

@end

NS_ASSUME_NONNULL_END
