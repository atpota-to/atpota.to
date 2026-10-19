#!/bin/sh
# Vercel install step for the Open Graph cards (scripts/og-images.ts, run by the build
# command in vercel.json): the shared libraries Playwright's headless Chromium links
# against, which the Amazon Linux 2023 build image doesn't all have, plus a fallback
# font for glyphs Eigerdals lacks, then the browser itself. PLAYWRIGHT_BROWSERS_PATH=0
# keeps it in node_modules, which Vercel's build cache restores.
#
# Never fails the install: without a browser, `npm run og -- --soft` warns and the
# deployment keeps the committed cards in public/og.

export PLAYWRIGHT_BROWSERS_PATH=0

if command -v dnf >/dev/null 2>&1; then
  # By soname (dnf resolves the package), so the list reads like `readelf -d` of the binary.
  dnf install -y -q --setopt=install_weak_deps=False --setopt=strict=0 \
    'libX11.so.6()(64bit)' 'libXcomposite.so.1()(64bit)' 'libXdamage.so.1()(64bit)' \
    'libXext.so.6()(64bit)' 'libXfixes.so.3()(64bit)' 'libXrandr.so.2()(64bit)' \
    'libasound.so.2()(64bit)' 'libatk-1.0.so.0()(64bit)' 'libatk-bridge-2.0.so.0()(64bit)' \
    'libatspi.so.0()(64bit)' 'libdbus-1.so.3()(64bit)' 'libexpat.so.1()(64bit)' \
    'libgbm.so.1()(64bit)' 'libgio-2.0.so.0()(64bit)' 'libnspr4.so()(64bit)' \
    'libnss3.so()(64bit)' 'libnssutil3.so()(64bit)' 'libudev.so.1()(64bit)' \
    'libxcb.so.1()(64bit)' 'libxkbcommon.so.0()(64bit)' \
    fontconfig dejavu-sans-fonts \
    || echo "og-browser: dnf couldn't install everything; Chromium may not start"
fi

npx playwright install chromium-headless-shell \
  || echo "og-browser: couldn't download Chromium; the build will keep the committed cards"

exit 0
