#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface PressureLogger : NSObject

+ (instancetype)sharedInstance;

- (void)log:(NSString *)format, ... NS_FORMAT_FUNCTION(1, 2);
- (void)logMessage:(NSString *)message;
- (NSArray<NSString *> *)recentLogs;
- (void)clear;

@end

#define PressureLog(fmt, ...) [[PressureLogger sharedInstance] log:fmt, ##__VA_ARGS__]

NS_ASSUME_NONNULL_END
