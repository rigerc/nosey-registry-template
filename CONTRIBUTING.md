# Contributing

This is a repository template for Nosey skill registries. Follow a
self-contained, reproducible workflow informed by
[ianlewis/repo-template](https://github.com/ianlewis/repo-template).

1. Make changes on a branch and explain the purpose in your pull request.
2. Put local skills in `skills/<name>/SKILL.md` with YAML frontmatter
   containing `name` and `description`.
3. Maintain recommendations in `skills-map.json` manually.
4. Run `npm ci`, then `make generate` and `make check` to review generated files,
   validate JSON against Nosey's latest schemas and run tests. Schema validation
   requires network access to Nosey's public schemas;
   see [Registry validation](README.md#registry-validation).
   On push, the catalog workflow commits manifest and README catalog updates automatically
   when branch permissions allow it.
5. Run `nosey registry validate .` when the Nosey CLI is available.
6. Review agnix diagnostics for unsafe skill instructions.

Registry format changes belong in Nosey. This template fetches its JSON Schemas
from Nosey's `main` branch on each validation run. It does not distribute or pin
schema copies, and it does not generate schema documentation. Run
`nosey registry validate .` for parser, filesystem and cross-reference validation.
