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
            bundlePath = @"/Library/Application Support/Pressure";
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

        // Embedded fallback guarantees code execution even if bundle is missing
        if (!sPressureUserScript || sPressureUserScript.length == 0) {
            sPressureUserScript = kEmbeddedPressureUserJS;
            sPressureCSS = kEmbeddedPressureCSS;
            PressureLog(@"[Hooks] Loaded embedded JS (%lu bytes) and CSS (%lu bytes)", 
                        (unsigned long)sPressureUserScript.length, (unsigned long)sPressureCSS.length);
        }
    });
}

%hook UIWindow

- (void)becomeKeyWindow {
    %orig;

    // Attach long-press gesture (0.5s) to the window to detect holds on MENU or top bar
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
        // If long press is in the top header area (y <= 120, where avatar and MENU live)
        if (pt.y <= 120.0) {
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

        [[PressureBridge sharedInstance] attachToUserContentController:ucc];

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
            WKUserScript *cssScript = [[WKUserScript alloc] initWithSource:wrappedCSS
                                                             injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                          forMainFrameOnly:NO];
            [ucc addUserScript:cssScript];
        }

        // Injected JS Suite
        if (sPressureUserScript.length > 0) {
            WKUserScript *userScript = [[WKUserScript alloc] initWithSource:sPressureUserScript
                                                              injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                                           forMainFrameOnly:NO];
            [ucc addUserScript:userScript];
        }

        PressureLog(@"[Hooks] Attached Pressure suite to WKWebView (%p)", self);
    }

    return %orig(frame, configuration);
}

- (WKNavigation *)loadRequest:(NSURLRequest *)request {
    PressureLog(@"[Hooks] WKWebView (%p) loadRequest: %@", self, request.URL.absoluteString);
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
