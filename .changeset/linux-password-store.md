---
"@open-codesign/desktop": patch
"@open-codesign/i18n": patch
---

Let Linux desktops Electron does not recognise pin a real password store. Saving an API key while the selected backend is basic_text now explains the selection failure and names the detected desktop. Settings → Advanced → Password store, or OPEN_CODESIGN_PASSWORD_STORE, is applied before the app is ready and persists across launches.
