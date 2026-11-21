#import "PressureBridge.h"
#import "PressureConfig.h"
#import "PressureLogger.h"
#import "PressureBiometrics.h"
#import "PressureSettingsViewController.h"
#import <UIKit/UIKit.h>

NSString *const kPressureBridgeName = @"pressureBridge";

@interface PressureBridge ()
@property (nonatomic, strong) NSHashTable<WKWebView *> *activeWebViews;
@end

@implementation PressureBridge

+ (instancetype)sharedInstance {
    static PressureBridge *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[PressureBridge alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _activeWebViews = [NSHashTable weakObjectsHashTable];
    }
    return self;
}

- (void)registerWebView:(WKWebView *)webView {
    if (!webView) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.activeWebViews addObject:webView];
    });
}

- (void)broadcastJavaScript:(NSString *)js {
    if (!js || js.length == 0) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        for (WKWebView *wv in self.activeWebViews) {
            [wv evaluateJavaScript:js completionHandler:nil];
        }
    });
}

- (void)attachToUserContentController:(WKUserContentController *)controller {
    [self attachToUserContentController:controller inWorld:nil];
}

- (void)attachToUserContentController:(WKUserContentController *)controller inWorld:(nullable id)world {
    // Avoid double registration
    @try {
        [controller removeScriptMessageHandlerForName:kPressureBridgeName];
    } @catch (NSException *e) {}

    if (world && @available(iOS 14.0, *)) {
        if ([world isKindOfClass:[WKContentWorld class]]) {
            [controller addScriptMessageHandler:self contentWorld:(WKContentWorld *)world name:kPressureBridgeName];
            return;
        }
    }

    [controller addScriptMessageHandler:self name:kPressureBridgeName];
}

- (void)detachFromUserContentController:(WKUserContentController *)controller {
    @try {
        [controller removeScriptMessageHandlerForName:kPressureBridgeName];
    } @catch (NSException *e) {}
}

#pragma mark - WKScriptMessageHandler

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.name isEqualToString:kPressureBridgeName]) return;
    if (![message.body isKindOfClass:[NSDictionary class]]) return;

    NSDictionary *body = (NSDictionary *)message.body;
    NSString *action = body[@"action"];
    NSString *callbackId = body[@"callbackId"];
    NSDictionary *payload = body[@"payload"];
    WKWebView *webView = message.webView;

    if (webView) {
        [self registerWebView:webView];
    }

    if ([action isEqualToString:@"getConfig"]) {
        NSDictionary *cfg = [[PressureConfig sharedInstance] toDictionary];
        [self sendResponseToWebView:webView callbackId:callbackId data:cfg error:nil];
    }
    else if ([action isEqualToString:@"saveConfig"]) {
        [[PressureConfig sharedInstance] updateFromDictionary:payload];
        [self sendResponseToWebView:webView callbackId:callbackId data:@{@"success": @YES} error:nil];
    }
    else if ([action isEqualToString:@"openSettingsModal"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [PressureSettingsViewController presentFromRoot];
        });
        [self sendResponseToWebView:webView callbackId:callbackId data:@{@"opened": @YES} error:nil];
    }
    else if ([action isEqualToString:@"authenticateBiometrics"]) {
        NSString *desc = payload[@"description"] ?: @"Steam Action";
        [[PressureBiometrics sharedInstance] authenticateForAction:desc
                                                        completion:^(BOOL success, NSError * _Nullable error) {
            if (success) {
                [self sendResponseToWebView:webView callbackId:callbackId data:@{@"authenticated": @YES} error:nil];
            } else {
                NSString *errStr = error.localizedDescription ?: @"Authentication failed";
                [self sendResponseToWebView:webView callbackId:callbackId data:@{@"authenticated": @NO} error:errStr];
            }
        }];
    }
    else if ([action isEqualToString:@"openChatDeepLink"]) {
        NSString *steamId = payload[@"steamId"];
        if (!steamId || steamId.length == 0) {
            [self sendResponseToWebView:webView callbackId:callbackId data:nil error:@"Missing steamId"];
            return;
        }

        NSString *urlStr = [NSString stringWithFormat:@"steamchatmobile://friend/%@", steamId];
        NSURL *url = [NSURL URLWithString:urlStr];
        dispatch_async(dispatch_get_main_queue(), ^{
            if ([[UIApplication sharedApplication] canOpenURL:url]) {
                [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:^(BOOL success) {
                    [self sendResponseToWebView:webView callbackId:callbackId data:@{@"opened": @(success)} error:nil];
                }];
            } else {
                PressureLog(@"Steam Chat app is not installed or scheme steamchatmobile:// is unregistered");
                [self sendResponseToWebView:webView callbackId:callbackId data:@{@"opened": @NO} error:@"Steam Chat app not found"];
            }
        });
    }
    else if ([action isEqualToString:@"log"]) {
        NSString *msg = payload[@"message"];
        if (msg) {
            PressureLog(@"[Web] %@", msg);
        }
    }
    else if ([action isEqualToString:@"getLogs"]) {
        NSArray *logs = [[PressureLogger sharedInstance] recentLogs];
        [self sendResponseToWebView:webView callbackId:callbackId data:@{@"logs": logs} error:nil];
    }
    else if ([action isEqualToString:@"getAppInfo"]) {
        NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
        NSDictionary *appData = @{
            @"version": info[@"CFBundleShortVersionString"] ?: @"Unknown",
            @"build": info[@"CFBundleVersion"] ?: @"Unknown",
            @"bundleId": [[NSBundle mainBundle] bundleIdentifier] ?: @"Unknown"
        };
        [self sendResponseToWebView:webView callbackId:callbackId data:appData error:nil];
    }
}

- (void)sendResponseToWebView:(WKWebView *)webView
                   callbackId:(NSString *)callbackId
                         data:(id)data
                        error:(NSString *)error {
    if (!callbackId || !webView) return;

    NSMutableDictionary *resp = [NSMutableDictionary dictionary];
    resp[@"callbackId"] = callbackId;
    if (data) resp[@"data"] = data;
    if (error) resp[@"error"] = error;

    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
    if (!jsonData) return;
    NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];

    NSString *js = [NSString stringWithFormat:@"window.__pressureNativeResponse && window.__pressureNativeResponse(%@);", jsonStr];
    dispatch_async(dispatch_get_main_queue(), ^{
        [webView evaluateJavaScript:js completionHandler:nil];
    });
}

@end
