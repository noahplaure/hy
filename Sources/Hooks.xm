#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import "PressureConfig.h"
#import "PressureLogger.h"
#import "PressureBridge.h"

static NSString *sPressureUserScript = nil;
static NSString *sPressureCSS = nil;

static void LoadPressureAssets(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSBundle *mainBundle = [NSBundle mainBundle];
        NSString *bundlePath = [mainBundle pathForResource:@"Pressure" ofType:@"bundle"];
        if (!bundlePath) {
            // Sideloaded directory fallback
            bundlePath = @"/Library/Application Support/Pressure";
            if (![[NSFileManager defaultManager] fileExistsAtPath:bundlePath]) {
                bundlePath = [[mainBundle bundlePath] stringByAppendingPathComponent:@"Pressure.bundle"];
            }
        }

        NSString *jsPath = [bundlePath stringByAppendingPathComponent:@"Pressure.user.js"];
        NSString *cssPath = [bundlePath stringByAppendingPathComponent:@"Pressure.css"];

        NSError *err = nil;
        sPressureUserScript = [NSString stringWithContentsOfFile:jsPath encoding:NSUTF8StringEncoding error:&err];
        if (err || !sPressureUserScript) {
            PressureLog(@"Failed to load Pressure.user.js from %@: %@", jsPath, err.localizedDescription);
        }

        sPressureCSS = [NSString stringWithContentsOfFile:cssPath encoding:NSUTF8StringEncoding error:nil];
    });
}

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

        PressureLog(@"Injected Pressure suite into WKWebView configuration");
    }

    return %orig(frame, configuration);
}

%end

%ctor {
    @autoreleasepool {
        NSString *bundleID = [[NSBundle mainBundle] bundleIdentifier];
        if (![bundleID isEqualToString:@"com.valvesoftware.Steam"]) {
            return;
        }

        NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
        PressureLog(@"Initializing Pressure tweak for Steam Mobile (version: %@)...", version);

        PressureConfig *cfg = [PressureConfig sharedInstance];
        if (![cfg validateAppVersion:version]) {
            PressureLog(@"Safe Mode engaged. Active hooks disabled to prevent instability.");
            return;
        }

        LoadPressureAssets();
        %init;
        PressureLog(@"Pressure initialization completed successfully.");
    }
}
