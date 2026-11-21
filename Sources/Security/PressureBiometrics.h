#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^PressureAuthCompletion)(BOOL success, NSError * _Nullable error);

@interface PressureBiometrics : NSObject

+ (instancetype)sharedInstance;

- (BOOL)isBiometricsAvailable;
- (void)authenticateForAction:(NSString *)actionDescription
                   completion:(PressureAuthCompletion)completion;

@end

NS_ASSUME_NONNULL_END
