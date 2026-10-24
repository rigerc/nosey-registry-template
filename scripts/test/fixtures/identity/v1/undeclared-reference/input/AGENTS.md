<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->
# Registry template agent guide

This file describes maintaining the Nosey registry template repository. If this repository was created from the template, replace this file with your registry's own `AGENTS.md` by running `node scripts/configure-registry.mjs owner/repository`.

The template repository contains tooling and workflows for maintaining the upstream template. A derived registry has its own history and should use its own guide. Nosey owns the registry schema contract; this template references the latest public schemas.

## Editing the template

Keep `skills-map.json` as the identity and mapping source, keep generated files current, and use Node.js 22 built-ins for template scripts and tests. Do not add example skills, schema copies, `registry.json`, or package dependencies. Run `node --test` and the documented generation checks before committing template changes.

## Repository boundary

Make template content changes in the template repository first. Nosey consumes a reviewed template revision; runtime, parser, and schema changes belong in Nosey.
