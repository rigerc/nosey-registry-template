# Shared registry schemas

Nosey is canonical for registry JSON formats. Validation consumes the latest
schemas from `rigerc/nosey`'s `main` branch on every run. The template keeps no
schema snapshot, revision pin, generated validator or offline fallback.

## Plan

- [x] Inspect Nosey's existing schemas and parser contract.
- [x] Replace handwritten validation with Ajv using the latest manifest v1 and
      map v1/v2 JSON Schemas fetched from Nosey.
- [x] Validate `registry.json` using the manifest header contract, matching
      Nosey's existing behavior; Nosey does not publish a separate schema for it.
- [x] Add editor annotations pointing at the same canonical schemas.
- [x] Install Ajv in CI and document the network requirement for `make validate`
      and `make check`.
- [x] Test accepted/rejected JSON, fetching the latest schemas on every call,
      read-only behavior, and network/HTTP/invalid-schema failures.
- [x] Run the complete checks against the current schemas on Nosey's `main`.

## Boundaries

The validator checks JSON structure only: schema versions, fields, types and
schema constraints. It does not maintain a second implementation of Nosey's
parser or filesystem/reference checks. Use `nosey registry validate .` for full
registry validation. Schema fetches use fixed Nosey URLs, not the documents'
potentially customized `$schema` annotations. Fetch failures fail validation
instead of silently using stale schemas.

Format changes belong in Nosey first. Latest-schema validation can change when
Nosey updates `main`, without a commit to this template; that is intentional.
The YAML block parser and manifest CLI argument findings remain separate work.

## Verification

- `npm ci --ignore-scripts` and `make check`: passed; 33 tests.
- Latest public schemas: both fetched without credentials (HTTP 200).
- All 100 canonical Nosey schema fixtures matched their declared schema verdicts.
- Configuring `acme/_skills` then validating against the latest schemas: passed.
- `git diff --check`: passed.
