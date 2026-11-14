---
"@open-codesign/desktop": patch
---

Keep large design sessions responsive. Chat projection reuses one in-memory session index and appends a single JSONL line per row, and run-journal durability flushes coalesce to a turn boundary instead of syncing every tool event.
