# Contributing

This repository is a template for Nosey skill registries. Changes to the template tooling and workflows belong here; Nosey owns registry runtime behavior and schemas. Preserve the separation between template infrastructure and downstream-owned registry content.

## Registry changes

1. Use Node.js 22 or newer. The template uses Node built-ins and requires no `npm ci`, `npm install`, or other dependency installation.
2. Add or update skill files under `skills/` and mappings in `skills-map.json`. Agnix separately validates skill quality; generators only extract manifest metadata.
3. Run `npm run generate` and include the generated manifest and marker-delimited README catalog in the same change.
4. Run `npm run generate:check`, `npm run validate`, `npm test`, `npm run check`, and `git diff --check`. `check` is read-only and does not run agnix.
5. Provision agnix separately and run `npm run lint` (or `npm run lint:strict`) when skill content changes. These commands do not install agnix. CI uses the separately pinned agnix release.

Schema validation fetches the latest manifest and map schemas from Nosey's fixed public `main` URLs on each run. Network, HTTP, schema parse, or unsupported-keyword failures stop validation; there is no cache or fallback. Explicit `--schemas <dir>` overrides are for test/CI fixtures only. Instance `$schema` annotations are preserved but never dereferenced by the validator.

The CI workflow always checks generated output, live registry validation, and tests without installing packages. Agnix runs for `skills/**` changes, and manual dispatch forces the audit. The generation workflow commits manifest and README updates on `main` as a safety net; pull requests must include generated output already.

Template sync is a reviewed pull request. Inspect path ownership and security-sensitive workflow changes before merging; do not bypass checks or overwrite downstream-owned registry content. Preserve source attribution and security escalations when adapting repository materials.
