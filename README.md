# Nosey registry template

Create shareable AI agent skill registries for [Nosey](https://github.com/rigerc/nosey). This template provides dependency-free generators, identity configuration, validation, and reviewed infrastructure updates.

<!-- BEGIN GENERATED SKILL CATALOG -->

## Skill catalog

Registry: example/agent-skills · 0 skills.

Generated from [skills-manifest.json](skills-manifest.json) and [skills-map.json](skills-map.json). Edit those sources or skill frontmatter, then regenerate this section.

Recommendation conditions below are alternatives; matching any condition can recommend a skill. Technology detection is handled by Nosey.

No skills are registered.

<!-- END GENERATED SKILL CATALOG -->

## Create and configure a registry

GitHub's web **Use this template** flow copies files but does not run the configurator. A web-created repository is **unconfigured**: its `registryId` and local skill IDs still use `example/agent-skills`, and its root `AGENTS.md` still contains upstream maintainer instructions. Clone it and explicitly configure it before adding or publishing registry content:

```sh
gh repo clone your-org/your-skills
cd your-skills
node scripts/configure-registry.mjs your-org/your-skills
npm run check
```

Use Node.js 22. No dependency installation is needed; `npm run` only dispatches checked-in scripts. Configuration rewrites the declared local identity, preserves external skill IDs and custom `$schema` annotations, regenerates the manifest and README catalog, and installs the canonical downstream `AGENTS.md` only when the existing guide is the verified template maintainer guide. A user-authored guide is preserved. The operation is safe to repeat with the same identity.

Validation fetches the two latest public Nosey schemas on every run and fails closed when the network or schema evaluation fails. It never follows a registry document's `$schema` value. The validator's `--schemas <dir>` option is only for explicit tests and CI fixtures.

Add skills under `skills/<name>/SKILL.md`; nested skill directories are supported. Edit `skills-map.json` to associate local or declared external skills with technologies and combinations. Then regenerate and check the committed outputs:

```sh
npm run generate
npm run generate:check
npm run validate
npm test
npm run check
```

`generate:check` is read-only. `check` checks generated output, live schema validation, and tests; it does not run agnix. Run agnix separately when skill content changes. Agnix is separately provisioned, not an npm dependency or part of generation. See [Contributing](CONTRIBUTING.md) for the local commands.

## Receive template updates

Derived registries receive infrastructure updates through reviewed [template-sync pull requests](.github/workflows/template-sync.yml). Configure the `TEMPLATE_SYNC_TOKEN` secret with Contents, Pull requests, and Workflows write permissions to enable scheduled updates. Review every diff; the sync workflow must preserve downstream-owned skills, identity, mappings, generated files, licensing, and root agent guidance. See [TEMPLATE_UPDATES.md](TEMPLATE_UPDATES.md) for setup and recovery guidance.

## Use with Nosey

Register a local or published registry separately:

```sh
nosey registry add /path/to/your-skills
nosey scan .
```

```sh
nosey registry add https://github.com/your-org/your-skills.git --ref main
```

Nosey reads registry metadata and does not install or execute skill files during detection. For parser, filesystem, and cross-reference validation, use `nosey registry validate /path/to/your-skills` when the Nosey CLI is available.

## Repository boundaries and attribution

Nosey owns the runtime and registry schema contract. This repository owns the template tooling and its documentation. Schema changes begin in Nosey; update the template's bounded validator and tests in the reviewed compatibility sequence. The template uses Node.js 22 built-ins and has no project package dependencies, lockfile, or install step. The template-sync workflow proposes infrastructure changes; it does not publish or merge them automatically.

This template adapts repository practices from [ianlewis/repo-template](https://github.com/ianlewis/repo-template). See [NOTICE.md](NOTICE.md) for attribution and [LICENSE](LICENSE) for licensing terms.
