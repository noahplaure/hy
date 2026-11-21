#import "PressureBiometrics.h"
#import "PressureLogger.h"
#import <LocalAuthentication/LocalAuthentication.h>

@implementation PressureBiometrics

+ (instancetype)sharedInstance {
    static PressureBiometrics *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[PressureBiometrics alloc] init];
    });
    return instance;
}

- (BOOL)isBiometricsAvailable {
    LAContext *context = [[LAContext alloc] init];
    NSError *error = nil;
    return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error];
}

- (void)authenticateForAction:(NSString *)actionDescription
                   completion:(PressureAuthCompletion)completion {
    LAContext *context = [[LAContext alloc] init];
    context.localizedFallbackTitle = @"Enter Passcode";

    NSError *authError = nil;
    LAPolicy policy = LAPolicyDeviceOwnerAuthenticationWithBiometrics;

    if (![context canEvaluatePolicy:policy error:&authError]) {
        // Fall back to device passcode if biometrics not enrolled or disabled
        policy = LAPolicyDeviceOwnerAuthentication;
        if (![context canEvaluatePolicy:policy error:&authError]) {
            PressureLog(@"Biometrics/Passcode unavailable on device: %@", authError.localizedDescription);
            if (completion) completion(NO, authError);
            return;
        }
    }

    NSString *reason = [NSString stringWithFormat:@"Pressure: Authorize %@", actionDescription ?: @"Steam Confirmation"];

    [context evaluatePolicy:policy
            localizedReason:reason
                      reply:^(BOOL success, NSError * _Nullable error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (success) {
                PressureLog(@"Biometric authorization succeeded for: %@", actionDescription);
            } else {
                PressureLog(@"Biometric authorization failed: %@", error.localizedDescription);
            }
            if (completion) {
                completion(success, error);
            }
        });
    }];
}

@end
