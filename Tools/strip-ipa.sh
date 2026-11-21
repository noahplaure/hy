#!/usr/bin/env bash
set -eo pipefail

TARGET_IPA="$1"

if [[ -z "$TARGET_IPA" || ! -f "$TARGET_IPA" ]]; then
    echo "Usage: $0 <path-to-ipa>" >&2
    exit 1
fi

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[Pressure] Stripping IPA for sideloading compatibility: $TARGET_IPA"
unzip -qq "$TARGET_IPA" -d "$WORK_DIR"

APP_BUNDLE=$(find "$WORK_DIR/Payload" -maxdepth 1 -name "*.app" | head -n 1)
if [[ -z "$APP_BUNDLE" ]]; then
    echo "Error: No .app bundle found inside Payload/" >&2
    exit 1
fi

echo "[Pressure] Target bundle: $APP_BUNDLE"

# Remove application extensions and Watch apps which cause sideloading install failures
rm -rf "$APP_BUNDLE/PlugIns" \
       "$APP_BUNDLE/Watch" \
       "$APP_BUNDLE/WatchKit" \
       "$APP_BUNDLE/com.apple.WatchPlaceholder"

find "$APP_BUNDLE" -name "*.appex" -type d -prune -exec rm -rf {} +

# Clean code signatures for subsequent resigner
rm -rf "$APP_BUNDLE/_CodeSignature"

# Re-package stripped archive
rm -f "$TARGET_IPA"
(cd "$WORK_DIR" && zip -qry "$TARGET_IPA" Payload)

echo "[Pressure] IPA successfully stripped and repackaged."
