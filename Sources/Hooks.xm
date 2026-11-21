#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import "PressureConfig.h"
#import "PressureLogger.h"
#import "PressureBridge.h"
#import "PressureSettingsViewController.h"
#import "Resources_Embedded.h"

static NSString *sPressureUserScript = nil;
static NSString *sPressureCSS = nil;

static void LoadPressureAssets(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSBundle *mainBundle = [NSBundle mainBundle];
        NSString *bundlePath = [mainBundle pathForResource:@"Pressure" ofType:@"bundle"];
        if (!bundlePath) {
            bundlePath = @"/Library/Application Support/Pressure.bundle";
            if (![[NSFileManager defaultManager] fileExistsAtPath:bundlePath]) {
                bundlePath = [[mainBundle bundlePath] stringByAppendingPathComponent:@"Pressure.bundle"];
            }
        }

        NSString *jsPath = [bundlePath stringByAppendingPathComponent:@"Pressure.user.js"];
        NSString *cssPath = [bundlePath stringByAppendingPathComponent:@"Pressure.css"];

        if ([[NSFileManager defaultManager] fileExistsAtPath:jsPath]) {
            NSError *err = nil;
            sPressureUserScript = [NSString stringWithContentsOfFile:jsPath encoding:NSUTF8StringEncoding error:&err];
            sPressureCSS = [NSString stringWithContentsOfFile:cssPath encoding:NSUTF8StringEncoding error:nil];
            PressureLog(@"[Hooks] Loaded assets from disk (%@)", jsPath);
        }

        // Embedded fallback guarantees code execution even if bundle is missing or relocated
        if (!sPressureUserScript || sPressureUserScript.length == 0) {
            sPressureUserScript = GetEmbeddedPressureUserJS();
            sPressureCSS = GetEmbeddedPressureCSS();
            PressureLog(@"[Hooks] Loaded embedded JS (%lu bytes) and CSS (%lu bytes)", 
                        (unsigned long)sPressureUserScript.length, (unsigned long)sPressureCSS.length);
        }
    });
}

// Window gesture delegate to allow simultaneous touch recognition with WKWebView
@interface PressureGestureDelegate : NSObject <UIGestureRecognizerDelegate>
+ (instancetype)sharedInstance;
@end

@implementation PressureGestureDelegate
+ (instancetype)sharedInstance {
    static PressureGestureDelegate *inst = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        inst = [[PressureGestureDelegate alloc] init];
    });
    return inst;
}
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer {
    return YES;
}
@end

%hook UIApplication

- (void)openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenExternalURLOptionsKey, id> *)options completionHandler:(void (^)(BOOL success))completion {
    NSString *urlStr = url.absoluteString;
    if ([urlStr hasPrefix:@"steamchatmobile:"] || 
        [urlStr containsString:@"s.team/chat/openapp"] ||
        [urlStr containsString:@"itunes.apple.com/app/steam-chat"]) {
        PressureLog(@"[Hooks] Intercepted external Chat openURL: %@ -> Launching In-App Chat Tab", urlStr);
        [[PressureBridge sharedInstance] broadcastJavaScript:@"window.__pressureOpenChatTab && window.__pressureOpenChatTab();"];
        if (completion) completion(YES);
        return;
    }
    %orig(url, options, completion);
}

- (BOOL)openURL:(NSURL *)url {
    NSString *urlStr = url.absoluteString;
    if ([urlStr hasPrefix:@"steamchatmobile:"] || 
        [urlStr containsString:@"s.team/chat/openapp"] ||
        [urlStr containsString:@"itunes.apple.com/app/steam-chat"]) {
        PressureLog(@"[Hooks] Intercepted external Chat openURL (legacy): %@ -> Launching In-App Chat Tab", urlStr);
        [[PressureBridge sharedInstance] broadcastJavaScript:@"window.__pressureOpenChatTab && window.__pressureOpenChatTab();"];
        return YES;
    }
    return %orig(url);
}

%end

%hook UIWindow

- (void)becomeKeyWindow {
    %orig;

    BOOL hasLongPress = NO;
    for (UIGestureRecognizer *gr in self.gestureRecognizers) {
        if ([gr.name isEqualToString:@"PressureMenuLongPress"]) {
            hasLongPress = YES;
            break;
        }
    }

    if (!hasLongPress) {
        UILongPressGestureRecognizer *lp = [[UILongPressGestureRecognizer alloc] initWithTarget:self action:@selector(pressure_handleWindowLongPress:)];
        lp.minimumPressDuration = 0.55;
        lp.cancelsTouchesInView = NO;
        lp.delegate = [PressureGestureDelegate sharedInstance];
        lp.name = @"PressureMenuLongPress";
        [self addGestureRecognizer:lp];
        PressureLog(@"[Hooks] Attached PressureMenuLongPress gesture to KeyWindow");
    }
}

- (void)motionEnded:(UIEventSubtype)motion withEvent:(UIEvent *)event {
    if (motion == UIEventSubtypeMotionShake) {
        PressureLog(@"[Hooks] Shake motion detected, presenting Pressure Settings");
        [PressureSettingsViewController presentFromRoot];
    }
    %orig(motion, event);
}

%new
- (void)pressure_handleWindowLongPress:(UILongPressGestureRecognizer *)sender {
    if (sender.state == UIGestureRecognizerStateBegan) {
        CGPoint pt = [sender locationInView:self];
        // Header bar region (y <= 130) covering MENU (left) or Avatar dropdown (right)
        if (pt.y <= 130.0) {
            PressureLog(@"[Hooks] Long-press detected in top bar area (pt: %.1f, %.1f), presenting Pressure Settings", pt.x, pt.y);
            [PressureSettingsViewController presentFromRoot];
        }
    }
}

%end

%hook WKWebView

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    PressureConfig *cfg = [PressureConfig sharedInstance];
    if (cfg.enabled && !cfg.safeMode) {
        LoadPressureAssets();

        WKUserContentController *ucc = configuration.userContentController ?: [[WKUserContentController alloc] init];
        configuration.userContentController = ucc;

        id pageWorld = nil;
        if (@available(iOS 14.0, *)) {
            pageWorld = [WKContentWorld pageWorld];
            [[PressureBridge sharedInstance] attachToUserContentController:ucc inWorld:pageWorld];
        } else {
            [[PressureBridge sharedInstance] attachToUserContentController:ucc];
        }

        // Injected CSS
        if (sPressureCSS.length > 0) {
            NSString *wrappedCSS = [NSString stringWithFormat:
                @"(() => {"
                @"  const s = document.createElement('style');"
                @"  s.id = 'pressure-injected-css';"
                @"  s.textContent = `%@`;"
                @"  (document.head || document.documentElement).appendChild(s);"
                @"})();",
                [sPressureCSS stringByReplacingOccurrencesOfString:@"`" withString:@"\\`"]
            ];

            WKUserScript *cssScript = nil;
            if (@available(iOS 14.0, *)) {
                cssScript = [[WKUserScript alloc] initWithSource:wrappedCSS
                                                   injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                forMainFrameOnly:NO
                                                  inContentWorld:pageWorld];
            } else {
                cssScript = [[WKUserScript alloc] initWithSource:wrappedCSS
                                                   injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                forMainFrameOnly:NO];
            }
            [ucc addUserScript:cssScript];
        }

        // Injected JS Suite (Page World for direct access to g_sessionID, g_rgWalletInfo, g_ActiveInventory)
        if (sPressureUserScript.length > 0) {
            WKUserScript *userScript = nil;
            if (@available(iOS 14.0, *)) {
                userScript = [[WKUserScript alloc] initWithSource:sPressureUserScript
                                                    injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                                 forMainFrameOnly:NO
                                                   inContentWorld:pageWorld];
            } else {
                userScript = [[WKUserScript alloc] initWithSource:sPressureUserScript
                                                    injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                                 forMainFrameOnly:NO];
            }
            [ucc addUserScript:userScript];
        }

        PressureLog(@"[Hooks] Attached Pressure suite to WKWebView (%p)", self);
    }

    WKWebView *webView = %orig(frame, configuration);
    [[PressureBridge sharedInstance] registerWebView:webView];
    return webView;
}

- (WKNavigation *)loadRequest:(NSURLRequest *)request {
    NSString *urlStr = request.URL.absoluteString;
    PressureLog(@"[Hooks] WKWebView (%p) loadRequest: %@", self, urlStr);
    [[PressureBridge sharedInstance] registerWebView:self];

    if ([urlStr containsString:@"s.team/chat"] || [urlStr containsString:@"steamcommunity.com/chat"]) {
        PressureLog(@"[Hooks] Intercepted Chat web navigation -> Launching In-App Chat Tab");
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self evaluateJavaScript:@"window.__pressureOpenChatTab && window.__pressureOpenChatTab();" completionHandler:nil];
        });
    }

    return %orig(request);
}

%end

%ctor {
    @autoreleasepool {
        NSString *bundleID = [[NSBundle mainBundle] bundleIdentifier];
        if (![bundleID isEqualToString:@"com.valvesoftware.Steam"]) {
            return;
        }

        NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
        PressureLog(@"=== Pressure Tweak Initializing ===");
        PressureLog(@"Target Bundle: %@", bundleID);
        PressureLog(@"App Version: %@", version);
        PressureLog(@"Disk log path: %@", [[PressureLogger sharedInstance] logFilePath]);

        PressureConfig *cfg = [PressureConfig sharedInstance];
        if (![cfg validateAppVersion:version]) {
            PressureLog(@"[SafeMode] Safe Mode engaged. Version %@ mismatch.", version);
            return;
        }

        LoadPressureAssets();
        %init;
        PressureLog(@"=== Pressure Initialization Complete ===");
    }
}
