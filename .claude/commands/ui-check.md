---
description: Check a UI change in a real browser (Chromium over CDP, phone size and desktop) with the existing harnesses
argument-hint: [what changed]
---
For `$ARGUMENTS`: start a scratch portal (`/scratch-portal`), then run the harness that covers it from `tools/qa/` (`ls tools/qa`; `scroll-lock.mjs` and `mobile-drag.mjs` for page and sheet behaviour,
`btw-layout.mjs` for the session page, `contrast.mjs`, `focus.mjs`, `textdiet.mjs`), or write a small one in the same style (CDP, `Emulation.setDeviceMetricsOverride` with touch,
`Emulation.setSafeAreaInsetsOverride` for an iPhone's insets: top 59, bottom 34). Check 390 and 1280 px, light and dark, keyboard and touch, and LOOK at a screenshot
(`Page.captureScreenshot`). A phone-layout fix is not done without a check that fails before it. Stop the portal.
