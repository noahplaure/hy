#import "PressureConfig.h"
#import "PressureLogger.h"

static NSString *const kDefaultsDomain = @"com.pressure.settings";

@interface PressureConfig ()
@property (nonatomic, assign, readwrite) BOOL safeMode;
@property (nonatomic, strong) NSUserDefaults *defaults;
@end

@implementation PressureConfig

+ (instancetype)sharedInstance {
    static PressureConfig *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[PressureConfig alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _defaults = [[NSUserDefaults alloc] initWithSuiteName:kDefaultsDomain] ?: [NSUserDefaults standardUserDefaults];
        [self loadDefaults];
    }
    return self;
}

- (void)loadDefaults {
    NSDictionary *reg = @{
        @"enabled": @YES,
        @"showPriceBadges": @YES,
        @"externalPrices": @NO,
        @"externalPriceSource": @"CSFloat",
        @"massSellEnabled": @YES,
        @"quickBuyOrderSell": @YES,
        @"biometricsForConfirmations": @YES,
        @"massConfirmTrades": @NO,
        @"tradeValuationWarning": @YES,
        @"tradeLossThresholdPercent": @(15.0),
        @"minPriceRatio": @(0.50),
        @"maxPriceRatio": @(3.00),
        @"requestDelayMs": @(350),
        @"priceCacheTtlSeconds": @(3600)
    };
    [_defaults registerDefaults:reg];

    _enabled = [_defaults boolForKey:@"enabled"];
    _showPriceBadges = [_defaults boolForKey:@"showPriceBadges"];
    _externalPrices = [_defaults boolForKey:@"externalPrices"];
    _externalPriceSource = [_defaults stringForKey:@"externalPriceSource"] ?: @"CSFloat";
    _massSellEnabled = [_defaults boolForKey:@"massSellEnabled"];
    _quickBuyOrderSell = [_defaults boolForKey:@"quickBuyOrderSell"];
    _biometricsForConfirmations = [_defaults boolForKey:@"biometricsForConfirmations"];
    _massConfirmTrades = [_defaults boolForKey:@"massConfirmTrades"];
    _tradeValuationWarning = [_defaults boolForKey:@"tradeValuationWarning"];
    _tradeLossThresholdPercent = [_defaults doubleForKey:@"tradeLossThresholdPercent"];
    _minPriceRatio = [_defaults doubleForKey:@"minPriceRatio"];
    _maxPriceRatio = [_defaults doubleForKey:@"maxPriceRatio"];
    _requestDelayMs = (NSUInteger)[_defaults integerForKey:@"requestDelayMs"];
    _priceCacheTtlSeconds = (NSUInteger)[_defaults integerForKey:@"priceCacheTtlSeconds"];
}

- (void)save {
    [_defaults setBool:_enabled forKey:@"enabled"];
    [_defaults setBool:_showPriceBadges forKey:@"showPriceBadges"];
    [_defaults setBool:_externalPrices forKey:@"externalPrices"];
    [_defaults setObject:_externalPriceSource forKey:@"externalPriceSource"];
    [_defaults setBool:_massSellEnabled forKey:@"massSellEnabled"];
    [_defaults setBool:_quickBuyOrderSell forKey:@"quickBuyOrderSell"];
    [_defaults setBool:_biometricsForConfirmations forKey:@"biometricsForConfirmations"];
    [_defaults setBool:_massConfirmTrades forKey:@"massConfirmTrades"];
    [_defaults setBool:_tradeValuationWarning forKey:@"tradeValuationWarning"];
    [_defaults setDouble:_tradeLossThresholdPercent forKey:@"tradeLossThresholdPercent"];
    [_defaults setDouble:_minPriceRatio forKey:@"minPriceRatio"];
    [_defaults setDouble:_maxPriceRatio forKey:@"maxPriceRatio"];
    [_defaults setInteger:(NSInteger)_requestDelayMs forKey:@"requestDelayMs"];
    [_defaults setInteger:(NSInteger)_priceCacheTtlSeconds forKey:@"priceCacheTtlSeconds"];
    [_defaults synchronize];
}

- (BOOL)validateAppVersion:(NSString *)currentVersion {
    // Steam Mobile 3.10.x tested base. Major jumps (e.g. 4.x) trigger safe mode.
    if (!currentVersion || currentVersion.length == 0) {
        PressureLog(@"Warning: Undefined app version, engaging safe mode fallback");
        _safeMode = YES;
        return NO;
    }

    NSArray<NSString *> *parts = [currentVersion componentsSeparatedByString:@"."];
    if (parts.count >= 1) {
        NSInteger major = [parts[0] integerValue];
        if (major != 3) {
            PressureLog(@"Major version shift (%@), activating Safe Mode to protect account actions", currentVersion);
            _safeMode = YES;
            return NO;
        }
    }

    _safeMode = NO;
    return YES;
}

- (NSDictionary<NSString *, id> *)toDictionary {
    return @{
        @"enabled": @(_enabled),
        @"safeMode": @(_safeMode),
        @"showPriceBadges": @(_showPriceBadges),
        @"externalPrices": @(_externalPrices),
        @"externalPriceSource": _externalPriceSource ?: @"CSFloat",
        @"massSellEnabled": @(_massSellEnabled),
        @"quickBuyOrderSell": @(_quickBuyOrderSell),
        @"biometricsForConfirmations": @(_biometricsForConfirmations),
        @"massConfirmTrades": @(_massConfirmTrades),
        @"tradeValuationWarning": @(_tradeValuationWarning),
        @"tradeLossThresholdPercent": @(_tradeLossThresholdPercent),
        @"minPriceRatio": @(_minPriceRatio),
        @"maxPriceRatio": @(_maxPriceRatio),
        @"requestDelayMs": @(_requestDelayMs),
        @"priceCacheTtlSeconds": @(_priceCacheTtlSeconds)
    };
}

- (void)updateFromDictionary:(NSDictionary<NSString *, id> *)dict {
    if (!dict) return;

    if (dict[@"enabled"]) self.enabled = [dict[@"enabled"] boolValue];
    if (dict[@"showPriceBadges"]) self.showPriceBadges = [dict[@"showPriceBadges"] boolValue];
    if (dict[@"externalPrices"]) self.externalPrices = [dict[@"externalPrices"] boolValue];
    if (dict[@"externalPriceSource"]) self.externalPriceSource = dict[@"externalPriceSource"];
    if (dict[@"massSellEnabled"]) self.massSellEnabled = [dict[@"massSellEnabled"] boolValue];
    if (dict[@"quickBuyOrderSell"]) self.quickBuyOrderSell = [dict[@"quickBuyOrderSell"] boolValue];
    if (dict[@"biometricsForConfirmations"]) self.biometricsForConfirmations = [dict[@"biometricsForConfirmations"] boolValue];
    if (dict[@"massConfirmTrades"]) self.massConfirmTrades = [dict[@"massConfirmTrades"] boolValue];
    if (dict[@"tradeValuationWarning"]) self.tradeValuationWarning = [dict[@"tradeValuationWarning"] boolValue];
    if (dict[@"tradeLossThresholdPercent"]) self.tradeLossThresholdPercent = [dict[@"tradeLossThresholdPercent"] doubleValue];
    if (dict[@"minPriceRatio"]) self.minPriceRatio = [dict[@"minPriceRatio"] doubleValue];
    if (dict[@"maxPriceRatio"]) self.maxPriceRatio = [dict[@"maxPriceRatio"] doubleValue];
    if (dict[@"requestDelayMs"]) self.requestDelayMs = [dict[@"requestDelayMs"] unsignedIntegerValue];
    if (dict[@"priceCacheTtlSeconds"]) self.priceCacheTtlSeconds = [dict[@"priceCacheTtlSeconds"] unsignedIntegerValue];

    [self save];
}

- (void)resetToDefaults {
    [_defaults removePersistentDomainForName:kDefaultsDomain];
    [self loadDefaults];
}

@end
