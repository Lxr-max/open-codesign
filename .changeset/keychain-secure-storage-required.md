---
"@open-codesign/desktop": patch
"@open-codesign/shared": patch
---

Refuse to save new API keys when OS secure storage is unavailable or uses the insecure Linux basic_text backend. Preserve existing keys during migration and show the secure-storage error when saving web search settings.
