#import "PressureLogger.h"

static const NSUInteger kPressureLogMaxLines = 500;

@interface PressureLogger () {
    NSMutableArray<NSString *> *_logBuffer;
    dispatch_queue_t _queue;
    NSDateFormatter *_dateFormatter;
    NSArray<NSRegularExpression *> *_redactionRegexes;
}
@end

@implementation PressureLogger

+ (instancetype)sharedInstance {
    static PressureLogger *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[PressureLogger alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _logBuffer = [NSMutableArray arrayWithCapacity:kPressureLogMaxLines];
        _queue = dispatch_queue_create("com.pressure.logger", DISPATCH_QUEUE_SERIAL);
        _dateFormatter = [[NSDateFormatter alloc] init];
        _dateFormatter.dateFormat = @"HH:mm:ss.SSS";

        // Precompile redaction patterns to prevent leaking sensitive session secrets
        NSArray<NSString *> *patterns = @[
            @"(sessionid=)[a-zA-Z0-9]+",
            @"(access_token=)[a-zA-Z0-9_.-]+",
            @"(steamLoginSecure=)[^;&\\s]+",
            @"(identity_secret[\"':= ]+)[a-zA-Z0-9+/=]+",
            @"(shared_secret[\"':= ]+)[a-zA-Z0-9+/=]+",
            @"(refreshToken[\"':= ]+)[a-zA-Z0-9_.-]+"
        ];

        NSMutableArray<NSRegularExpression *> *compiled = [NSMutableArray arrayWithCapacity:patterns.count];
        for (NSString *pattern in patterns) {
            NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern
                                                                                   options:NSRegularExpressionCaseInsensitive
                                                                                     error:nil];
            if (regex) {
                [compiled addObject:regex];
            }
        }
        _redactionRegexes = [compiled copy];
    }
    return self;
}

- (NSString *)sanitize:(NSString *)raw {
    if (!raw || raw.length == 0) return @"";
    NSMutableString *clean = [raw mutableCopy];
    for (NSRegularExpression *regex in _redactionRegexes) {
        [regex replaceMatchesInString:clean
                              options:0
                                range:NSMakeRange(0, clean.length)
                         withTemplate:@"$1[REDACTED]"];
    }
    return [clean copy];
}

- (void)log:(NSString *)format, ... {
    va_list args;
    va_start(args, format);
    NSString *msg = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    [self logMessage:msg];
}

- (void)logMessage:(NSString *)message {
    if (!message) return;
    dispatch_async(_queue, ^{
        NSString *sanitized = [self sanitize:message];
        NSString *timestamp = [self->_dateFormatter stringFromDate:[NSDate date]];
        NSString *entry = [NSString stringWithFormat:@"[%@] %@", timestamp, sanitized];

        if (self->_logBuffer.count >= kPressureLogMaxLines) {
            [self->_logBuffer removeObjectAtIndex:0];
        }
        [self->_logBuffer addObject:entry];

#if DEBUG
        NSLog(@"[Pressure] %@", entry);
#endif
    });
}

- (NSArray<NSString *> *)recentLogs {
    __block NSArray<NSString *> *copy = nil;
    dispatch_sync(_queue, ^{
        copy = [self->_logBuffer copy];
    });
    return copy ?: @[];
}

- (void)clear {
    dispatch_async(_queue, ^{
        [self->_logBuffer removeAllObjects];
    });
}

@end
