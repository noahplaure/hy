#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface PressureConfig : NSObject

+ (instancetype)sharedInstance;

@property (nonatomic, assign) BOOL enabled;
@property (nonatomic, assign, readonly) BOOL safeMode;

// Feature toggles
@property (nonatomic, assign) BOOL showPriceBadges;
@property (nonatomic, assign) BOOL externalPrices;
@property (nonatomic, copy) NSString *externalPriceSource; // "CSFloat" or "Skinport"
@property (nonatomic, assign) BOOL massSellEnabled;
@property (nonatomic, assign) BOOL quickBuyOrderSell;
@property (nonatomic, assign) BOOL biometricsForConfirmations;
@property (nonatomic, assign) BOOL massConfirmTrades; // Default NO for safety
@property (nonatomic, assign) BOOL tradeValuationWarning;
@property (nonatomic, assign) double tradeLossThresholdPercent; // Default 15.0%

// Safeguard ratios relative to median price
@property (nonatomic, assign) double minPriceRatio; // Default 0.5 (50% of median)
@property (nonatomic, assign) double maxPriceRatio; // Default 3.0 (300% of median)

// Network and caching
@property (nonatomic, assign) NSUInteger requestDelayMs; // Default 350ms
@property (nonatomic, assign) NSUInteger priceCacheTtlSeconds; // Default 3600s

- (NSDictionary<NSString *, id> *)toDictionary;
- (void)updateFromDictionary:(NSDictionary<NSString *, id> *)dict;
- (BOOL)validateAppVersion:(NSString *)currentVersion;
- (void)resetToDefaults;

@end

NS_ASSUME_NONNULL_END
