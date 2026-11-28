---
name: browser-automation
description: Navigate pages, refresh snapshots after each action, fill forms carefully, and hand off sign-in or MFA via Live View.
---

# Browser Automation

1. Open target URL with `browser_navigate`.
2. Inspect the current DOM/text state with `browser_snapshot` before clicking or typing.
3. After each `browser_click` or `browser_fill` that triggers navigation, capture a fresh `browser_snapshot`.
4. If login, CAPTCHA, or MFA blocks progress, call `browser_request_takeover` so the user can complete sign-in in Live View.
5. Ask the user in chat before submitting payment, checkout, or irreversible form actions.
