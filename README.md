# Pressure (Steam Mobile iOS Power-User Suite)

An advanced tweak for sideloaded Steam Mobile on iOS delivering desktop-grade Steam Inventory Helper features, enhanced market tools, and deep Steam Chat integration.

---

## Features

- **Inventory Value & Pricing Badges:** Real-time lowest and median prices, 24h volume, and total inventory valuation.
- **Mass Selling:** Multi-item selection, undercut mode (-1¢), quick sell via buy orders (`item_nameid`), dry-run simulation, and median safeguard limits.
- **My Listings:** Bulk cancellation, market relisting, and undercut warnings.
- **Safe Confirmations:** Mass confirmation of market listings protected by **Face ID / Passcode** via `LocalAuthentication`.
- **Trade Valuation:** Real-time side-by-side value comparison with automatic deficit warnings on high-loss trades.
- **Steam Chat:** Direct profile deep linking (`steamchatmobile://friend/{steamid}`) and integrated in-app messaging via `IFriendMessagesService`.

---

## Build & Sideload Injection (GitHub Actions)

The repository includes a ready-to-use GitHub Actions workflow (`.github/workflows/build_and_inject.yml`) that compiles the Theos rootless package, strips app extensions, and injects `Pressure` into `Steam.ipa` using `cyan`.

### Option 1: Commit with local IPA (Easiest)
1. Ensure your decrypted `Steam.ipa` is located in `ipa/Steam.ipa` (or repository root).
2. Push repository to GitHub (`main` or `master` branch).
3. The workflow triggers automatically, builds the package, injects it, and provides the ready IPA in the **Actions Artifacts** tab.

### Option 2: Run via Workflow Dispatch
1. Go to the **Actions** tab on your GitHub repository.
2. Select **Build Pressure & Inject IPA** -> **Run workflow**.
3. (Optional) Provide a direct download URL in `ipa_url`.
4. Choose upload target (`artifacts`, `filebin`, or `both`).
5. Download your modified `Steam-Pressure-3.10.13.ipa` directly from the workflow summary or filebin.

---

## Sideloading Compatibility

The built IPA is automatically sanitized by `Tools/strip-ipa.sh` (removing `PlugIns`, `WatchKit`, and `*.appex`), making it fully compatible with:
- **SideStore**
- **LiveContainer**
- **AltStore / AltServer**
- **TrollStore**
- **Scarlet / Sideloadly**
