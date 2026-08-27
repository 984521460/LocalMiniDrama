# Versioned JSON Schemas

This directory is the reviewable source of truth for cross-module transport contracts.

- `v1` currently means the exact contract version `1.0.0`.
- Consumers must reject missing, malformed, and unknown versions; forward compatibility is never assumed.
- `result-envelope.schema.json` and `contract-error.schema.json` are a schema set. Register both `$id` values when using a JSON Schema validator.
- Error messages are fixed by error code. Provider response bodies, exception text, credentials, prompts, and other raw upstream data must never be copied into a result envelope.
- Task-specific payload Schemas are added by the phase that owns each task. This base layer intentionally does not guess future narrative payloads.
