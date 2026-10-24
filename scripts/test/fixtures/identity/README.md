# Identity conformance fixtures

Version `v1` is the shared data contract for the template configurator and Nosey's in-process registry initializer. These files are test inputs and expected outputs, not schema, parser, or implementation dependencies. Consumers must treat each `case.json` verdict as authoritative and must not infer expected success from whether their implementation accepts a document.

Run the fixture integrity checks with `node --test scripts/test/fixtures/identity/fixtures.test.mjs`. The checks use Node 22 built-ins only and do not require a generator or configurator.

## Layout

Each case directory contains `case.json` and its named input files. Successful rewrite cases also contain exact expected output files. `case.json` declares `kind`, an independently selected `verdict`, files to compare, and policy layers:

- `schema`: structural schema verdict (pass/fail/not-applicable).
- `parser`: Nosey parser-only verdict (pass/fail/not-applicable).
- `integration`: identity, path, reference, README, guide, or filesystem contract verdict.

The fixture metadata's `expectedError` names the rejecting layer and stable reason; implementations may add diagnostic detail. `unchangedOnReject` means every input byte must remain unchanged after a rejected or recoverable failed operation. `write-failure` injects a recoverable staging/rename failure and requires rollback. `idempotency` compares every configured output byte-for-byte after a second run with the same requested identity.

## Guide recognition and README markers

Catalog markers are exactly `<!-- BEGIN GENERATED SKILL CATALOG -->` and `<!-- END GENERATED SKILL CATALOG -->`. There must be exactly one of each, in that order. Missing, duplicate, or reversed markers reject configuration before any write.

The unique maintainer sentinel is the exact first line `<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->`. Recognition requires both that sentinel and byte-for-byte equality of the complete root `AGENTS.md` with `maintainer-guide.md` (including final LF); matching a title or sentinel alone is insufficient. The canonical downstream guide is `downstream-guide.md` and the configured expected result is exactly that file. A guide without the sentinel is user-owned and preserved byte-for-byte. A file containing the sentinel but differing from the verified maintainer guide is conflicting maintainer-like content and must be rejected without changes.

## Cases

- `configure-success`: full mapping rewrite and canonical downstream guide installation.
- `guide-user-preserved`: preserve a user-owned root guide.
- `guide-conflict`: reject a modified maintainer-like guide.
- `malformed-map`, `identity-mismatch`, `path-mismatch`, `undeclared-reference`: reject malformed or inconsistent inputs.
- `readme-missing`, `readme-duplicate`, `readme-reversed`: reject invalid catalog marker structure.
- `invalid-request`: reject malformed requested owner/repository identity.
- `write-failure`: roll back all files after a recoverable write failure.

The main case exercises nested local IDs, all six map-reference locations (`alwaysRecommend`, `technologies[].skills`, `technologySkills[].skills`, `combinations[].skills`, `combinationSkills[].skills`, `frontendBonusSkills`), an external ID colliding with the old local prefix, custom `$schema` values with string/object/array/number/boolean/null values across both documents, unknown top-level/nested fields, v1 null optional arrays, and absent `externalSkills`. Local membership is determined only by declared manifest IDs; prefix resemblance does not confer locality.
