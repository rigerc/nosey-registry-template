# Contributing

This is a repository template for Nosey skill registries. Follow a
self-contained, reproducible workflow informed by
[ianlewis/repo-template](https://github.com/ianlewis/repo-template).

1. Make changes on a branch and explain the purpose in your pull request.
2. Put local skills in `skills/<name>/SKILL.md` with YAML frontmatter
   containing `name` and `description`.
3. Maintain recommendations in `skills-map.json` manually.
4. Run `make generate` and `make check`, then commit generated files.
5. Run `nosey registry validate .` when the Nosey CLI is available.
6. Review agnix diagnostics for unsafe skill instructions.

For schema changes, coordinate with the equivalent Nosey schemas, run
`make schema-docs` to regenerate `docs/registry-schema.md`, and run
`make check` to verify the generated reference and registry files.
