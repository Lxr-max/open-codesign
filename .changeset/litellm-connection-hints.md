---
"@open-codesign/shared": patch
"@open-codesign/i18n": patch
"@open-codesign/desktop": patch
---

Show LiteLLM-specific hints when a LiteLLM Gateway connection test or model discovery fails. A 401 says to set the master or virtual key or turn off keyless mode, a 404 says to check that the base URL ends with /v1 and that the proxy is on port 4000, and a connection refusal says to start the LiteLLM proxy.
