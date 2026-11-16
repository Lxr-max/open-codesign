---
"@open-codesign/desktop": patch
---

Stop Open folder from hanging the workspace IPC channel when the system file manager does not answer. Linux launches `xdg-open` directly, and every platform replies with a clear error if the opener never settles.
