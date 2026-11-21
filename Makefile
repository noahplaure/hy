ARCHS = arm64 arm64e
TARGET = iphone:16.5:14.0

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = Pressure

$(TWEAK_NAME)_FILES = $(shell find Sources -name '*.m' -o -name '*.mm' -o -name '*.xm')
$(TWEAK_NAME)_CFLAGS = -fobjc-arc -ISources -ISources/Config -ISources/Logger -ISources/Security -ISources/Bridge -Wno-deprecated-declarations -Wno-unused-variable -Wno-unused-function
$(TWEAK_NAME)_FRAMEWORKS = UIKit Foundation WebKit LocalAuthentication Security
$(TWEAK_NAME)_LOGOS_DEFAULT_GENERATOR = internal

BUNDLE_NAME = Pressure
$(BUNDLE_NAME)_INSTALL_PATH = /Library/Application Support/Pressure

after-stage::
	@echo ">>> Staging Pressure.bundle assets..."
	@mkdir -p $(THEOS_STAGING_DIR)/Library/Application\ Support/Pressure
	@cp -a Resources/* $(THEOS_STAGING_DIR)/Library/Application\ Support/Pressure/

include $(THEOS_MAKE_PATH)/tweak.mk
