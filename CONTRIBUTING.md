# Contributing

This repository is the source template for Nosey skill registries. Changes here are
template changes: they affect every repository created from the template, not one
published registry. Follow a self-contained, reproducible workflow informed by
[ianlewis/repo-template](https://github.com/ianlewis/repo-template).

## Before opening a pull request

1. Branch from `main` and explain the purpose and scope in the pull request.
2. Change generated files only by running `npm run generate`; never hand-edit
   `skills-manifest.json` or the README catalog.
3. Keep `skills/` empty except `.gitkeep` and keep the identity `example/agent-skills`.
   Example skills belong in a derived registry, not here.
4. Add or update tests under `scripts/test/` for any generator, validator, or
   configure change. Tests run through the real CLI against temporary fixtures.
5. Run the local gate:

   ```bash
   npm ci
   npm run generate
   npm run check
   git diff --check
   ```

   `npm run check` runs the generated-output check, validates against the latest
   Nosey schemas (network required, fails closed), and runs the test suite.
6. Run `npm run lint` when a change touches skill or agent configuration files.
   Use the pinned agnix version; `npm run lint:strict` treats warnings as errors.

## Review expectations

- Generated output matches the sources: a reviewer should never see a manual edit to
  `skills-manifest.json` or the README catalog.
- Validation is registry-only. Skill content, naming, descriptions, links, and
  instructions are agnix's responsibility; do not add content checks to the scripts.
- Do not weaken validation, agnix severities, or workflow permissions to make a check
  pass. Fix the input or explain the exception in the pull request.

## Schema changes

Registry format changes belong in Nosey. This template references the latest public
schemas, ships no schema copies or revision pins, and never generates schema
documentation. When Nosey changes a schema, update the template documentation and
tests that depend on it in a follow-up pull request.

`nosey registry validate .` remains the full local check when the Nosey CLI is
available; it adds parser, filesystem, and cross-reference rules beyond JSON Schema.
