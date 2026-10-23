# Contributing

This is a repository template for Nosey skill registries. Follow a
self-contained, reproducible workflow informed by
[ianlewis/repo-template](https://github.com/ianlewis/repo-template).

1. Make changes on a branch and explain the purpose in your pull request.
2. Put local skills in `skills/<name>/SKILL.md` with YAML frontmatter
   containing `name` and `description`.
3. Maintain recommendations in `skills-map.json` manually.
4. Run `make generate` and `make check` to review and validate generated files locally.
   On push, the catalog workflow commits manifest and README catalog updates automatically
   when branch permissions allow it.
5. Run `nosey registry validate .` when the Nosey CLI is available.
6. Review agnix diagnostics for unsafe skill instructions.

Registry format changes belong in Nosey. This template does not distribute JSON
Schemas or generate schema documentation. Run `nosey registry validate .` to check
registry data against the supported document versions.
