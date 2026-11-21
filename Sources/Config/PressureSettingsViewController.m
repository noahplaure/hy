#import "PressureSettingsViewController.h"
#import "PressureConfig.h"
#import "PressureLogger.h"

@interface PressureSettingsViewController ()
@end

@implementation PressureSettingsViewController

+ (void)presentFromRoot {
    UIViewController *top = [self topViewController];
    if (!top || [top isKindOfClass:[PressureSettingsViewController class]]) return;

    PressureSettingsViewController *settingsVC = [[PressureSettingsViewController alloc] initWithStyle:UITableViewStyleInsetGrouped];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:settingsVC];
    nav.modalPresentationStyle = UIModalPresentationPageSheet;

    [top presentViewController:nav animated:YES completion:nil];
}

+ (UIViewController *)topViewController {
    UIViewController *root = nil;
    for (UIWindowScene *scene in [UIApplication sharedApplication].connectedScenes) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            for (UIWindow *w in scene.windows) {
                if (w.isKeyWindow) {
                    root = w.rootViewController;
                    break;
                }
            }
        }
    }
    if (!root) {
        root = [UIApplication sharedApplication].keyWindow.rootViewController;
    }

    while (root.presentedViewController) {
        root = root.presentedViewController;
    }
    return root;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.title = @"Pressure Settings";

    self.view.backgroundColor = [UIColor colorWithRed:0.07 green:0.08 blue:0.10 alpha:1.0];
    self.tableView.backgroundColor = [UIColor colorWithRed:0.07 green:0.08 blue:0.10 alpha:1.0];
    self.tableView.separatorColor = [UIColor colorWithRed:0.16 green:0.28 blue:0.37 alpha:0.5];

    self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone
                                                                                           target:self
                                                                                           action:@selector(dismissSelf)];

    UINavigationBarAppearance *appearance = [[UINavigationBarAppearance alloc] init];
    [appearance configureWithOpaqueBackground];
    appearance.backgroundColor = [UIColor colorWithRed:0.09 green:0.10 blue:0.13 alpha:1.0];
    appearance.titleTextAttributes = @{NSForegroundColorAttributeName: [UIColor colorWithRed:0.40 green:0.75 blue:0.96 alpha:1.0]};

    self.navigationController.navigationBar.standardAppearance = appearance;
    self.navigationController.navigationBar.scrollEdgeAppearance = appearance;
}

- (void)dismissSelf {
    [self dismissViewControllerAnimated:YES completion:nil];
}

#pragma mark - Table View Data Source

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
    return 4;
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
    switch (section) {
        case 0: return @"General & Market";
        case 1: return @"Confirmations & Security";
        case 2: return @"Trade Safeguards";
        case 3: return @"Diagnostics & Actions";
        default: return nil;
    }
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    switch (section) {
        case 0: return 3; // Price badges, external pricing, mass selling
        case 1: return 2; // Biometrics, mass confirm trades
        case 2: return 1; // Trade deficit warning
        case 3: return 2; // View logs, reset defaults
        default: return 0;
    }
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    PressureConfig *cfg = [PressureConfig sharedInstance];
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
    cell.backgroundColor = [UIColor colorWithRed:0.11 green:0.16 blue:0.22 alpha:1.0];
    cell.textLabel.textColor = [UIColor colorWithRed:0.90 green:0.90 blue:0.90 alpha:1.0];
    cell.detailTextLabel.textColor = [UIColor colorWithRed:0.56 green:0.60 blue:0.63 alpha:1.0];

    UISwitch *sw = [[UISwitch alloc] init];
    sw.onTintColor = [UIColor colorWithRed:0.36 green:0.49 blue:0.06 alpha:1.0];

    if (indexPath.section == 0) {
        if (indexPath.row == 0) {
            cell.textLabel.text = @"Item Price Badges";
            cell.detailTextLabel.text = @"Show lowest market price on inventory items";
            sw.on = cfg.showPriceBadges;
            [sw addTarget:self action:@selector(togglePriceBadges:) forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = sw;
        } else if (indexPath.row == 1) {
            cell.textLabel.text = @"External Prices (CSFloat)";
            cell.detailTextLabel.text = @"Display external valuation badge";
            sw.on = cfg.externalPrices;
            [sw addTarget:self action:@selector(toggleExternalPrices:) forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = sw;
        } else if (indexPath.row == 2) {
            cell.textLabel.text = @"Mass Selling Module";
            cell.detailTextLabel.text = @"Multi-selection and automated queue";
            sw.on = cfg.massSellEnabled;
            [sw addTarget:self action:@selector(toggleMassSell:) forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = sw;
        }
    } else if (indexPath.section == 1) {
        if (indexPath.row == 0) {
            cell.textLabel.text = @"Require Face ID / Passcode";
            cell.detailTextLabel.text = @"Biometric gate before mass confirmations";
            sw.on = cfg.biometricsForConfirmations;
            [sw addTarget:self action:@selector(toggleBiometrics:) forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = sw;
        } else if (indexPath.row == 1) {
            cell.textLabel.text = @"Allow Trade Mass Confirmation";
            cell.detailTextLabel.text = @"Off by default to prevent accidental transfers";
            sw.on = cfg.massConfirmTrades;
            [sw addTarget:self action:@selector(toggleMassConfirmTrades:) forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = sw;
        }
    } else if (indexPath.section == 2) {
        if (indexPath.row == 0) {
            cell.textLabel.text = @"Trade Deficit Alert";
            cell.detailTextLabel.text = @"Warn when offering > 15% more value than receiving";
            sw.on = cfg.tradeValuationWarning;
            [sw addTarget:self action:@selector(toggleTradeWarning:) forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = sw;
        }
    } else if (indexPath.section == 3) {
        if (indexPath.row == 0) {
            cell.textLabel.text = @"View Diagnostics Log";
            cell.detailTextLabel.text = @"Sanitized in-memory circular buffer";
            cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
        } else if (indexPath.row == 1) {
            cell.textLabel.text = @"Reset All Settings";
            cell.textLabel.textColor = [UIColor colorWithRed:0.85 green:0.33 blue:0.31 alpha:1.0];
            cell.detailTextLabel.text = @"Restore defaults and reload";
        }
    }

    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath:indexPath animated:YES];

    if (indexPath.section == 3 && indexPath.row == 0) {
        [self showLogsViewer];
    } else if (indexPath.section == 3 && indexPath.row == 1) {
        [[PressureConfig sharedInstance] resetToDefaults];
        [self.tableView reloadData];
    }
}

- (void)showLogsViewer {
    NSArray<NSString *> *logs = [[PressureLogger sharedInstance] recentLogs];
    NSString *logText = [logs componentsJoinedByString:@"\n"];

    UIViewController *vc = [[UIViewController alloc] init];
    vc.title = @"Diagnostics Log";
    vc.view.backgroundColor = [UIColor colorWithRed:0.07 green:0.08 blue:0.10 alpha:1.0];

    UITextView *tv = [[UITextView alloc] initWithFrame:vc.view.bounds];
    tv.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    tv.backgroundColor = [UIColor colorWithRed:0.05 green:0.06 blue:0.07 alpha:1.0];
    tv.textColor = [UIColor colorWithRed:0.64 green:0.82 blue:0.03 alpha:1.0];
    tv.font = [UIFont fontWithName:@"Menlo" size:11.0] ?: [UIFont monospacedSystemFontOfSize:11.0 weight:UIFontWeightRegular];
    tv.editable = NO;
    tv.text = logText.length > 0 ? logText : @"No log entries recorded yet.";

    [vc.view addSubview:tv];
    [self.navigationController pushViewController:vc animated:YES];
}

#pragma mark - Actions

- (void)togglePriceBadges:(UISwitch *)sw {
    [PressureConfig sharedInstance].showPriceBadges = sw.on;
}

- (void)toggleExternalPrices:(UISwitch *)sw {
    [PressureConfig sharedInstance].externalPrices = sw.on;
}

- (void)toggleMassSell:(UISwitch *)sw {
    [PressureConfig sharedInstance].massSellEnabled = sw.on;
}

- (void)toggleBiometrics:(UISwitch *)sw {
    [PressureConfig sharedInstance].biometricsForConfirmations = sw.on;
}

- (void)toggleMassConfirmTrades:(UISwitch *)sw {
    [PressureConfig sharedInstance].massConfirmTrades = sw.on;
}

- (void)toggleTradeWarning:(UISwitch *)sw {
    [PressureConfig sharedInstance].tradeValuationWarning = sw.on;
}

@end
