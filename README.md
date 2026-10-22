# Nosey registry template

Use this template to maintain skills and map them to technologies detected by Nosey.

<!-- BEGIN GENERATED SKILL CATALOG -->

## Skill catalog

Registry: example/agent-skills · 0 skills.

Generated from [skills-manifest.json](skills-manifest.json) and [skills-map.json](skills-map.json). Edit those sources or skill frontmatter, then regenerate this section.

Recommendation conditions below are alternatives; matching any condition can recommend a skill. Technology detection is handled by Nosey.

No skills are registered.

<!-- END GENERATED SKILL CATALOG -->

## Create a registry

With Nosey installed, run:

```bash
nosey registry init ./my-registry --registry-id your-org/your-skills
```

In an interactive terminal, this opens a wizard with a final confirmation. The
destination must not already exist. For unattended creation without Git, use:

```bash
nosey registry init ./my-registry --registry-id your-org/your-skills --yes --no-git
```

Init copies this entire template, updates the registry identity, and refreshes the
README catalog. The new registry starts with no skills or recommendations. Git is
initialized by default. Add `--github` to create and push a GitHub repository using
an authenticated `gh` CLI; visibility defaults to private, or can be set with
`--visibility public`.

Alternatively, copy this directory manually, including
both workflows and `.agents/prompts/`, then update the identity as described below.

## Customize

1. If copied manually, set the same unique `registryId` in `registry.json` and
   `skills-map.json`, and update skill ID references in the map to match. Init
   already does this for you. Keep the `$schema` annotation at the top of
   `skills-manifest.json` and `skills-map.json`: it points at the copy of the contract
   shipped in `schemas/`, and every generator here preserves it.
2. Add your own skills under
   `skills/<skill-name>/SKILL.md`, with YAML frontmatter containing a name and
   a description explaining when to use the skill. Nested skill folders are supported.
3. From the registry directory, run `node scripts/generate-manifest.mjs` to generate
   `skills-manifest.json` using the identity in `registry.json`.
4. Run `node scripts/generate-readme.mjs` to refresh the skill catalog, then commit
   both `skills-manifest.json` and `README.md`.
5. Maintain `skills-map.json` manually. The generators never edit it. Update
   mappings when you delete or rename skills.
6. Push to GitHub. The included workflow tests generators and verifies the manifest
   and README catalog on pull requests. On main, it serializes updates and commits
   refreshed files together. Automatic updates require GitHub Actions to be allowed
   to push to main; branch protection must permit the bot, or contributors must
   commit regenerated files themselves. Manual runs update files only on main.

IDs use `<registryId>/<relative-directory-under-skills>`. Moving a skill changes its ID.

The manifest lists local skills, but does not automatically recommend them.
Map skills to built-in technologies with technologySkills, declare new technologies
with detection rules, declare combinations, extend existing combinations with
combinationSkills, add frontendBonusSkills, or list specific skill IDs in
`alwaysRecommend` to recommend them in every project using this registry. Mapped skill IDs must be declared either in the local manifest or in `externalSkills` in the map.

For an external upstream skill, use `schemaVersion: 2` in `skills-map.json` and add:

```json
"externalSkills": [
  {
    "id": "acme/upstream-skills/example-testing",
    "name": "External testing guidance",
    "source": "acme/upstream-skills",
    "skill": "example-testing"
  }
],
"technologySkills": [
  {"technologyId": "react", "skills": ["acme/upstream-skills/example-testing"]}
],
"alwaysRecommend": []
```

External sources accept GitHub `owner/repo`, `https://github.com/owner/repo`, and
`git@github.com:owner/repo` forms. Nosey reads declarative metadata only: it
never downloads or executes external skills when scanning. Skill existence upstream
is not automatically verified. Version 1 maps without `externalSkills` remain valid.

You can also mark individual skills through Nosey's Registries tab: open a local
registry, press `a`, select skills with Space, and save after reviewing the write
target. This updates `skills-map.json`, which the manifest generator preserves.
Commit and publish the map to share the marks with Git registry consumers.

## Regenerate the catalog

With Node.js 20 or later, run these commands from the registry directory after
editing skills or the map:

```bash
node scripts/generate-manifest.mjs
node scripts/generate-readme.mjs
```

Only the section between the generated catalog markers is replaced. Keep the
markers intact and edit descriptions in skill frontmatter and recommendation
rules in `skills-map.json`. Local and external skills without mappings remain
listed as available. External entries link to their upstream repository.
The generators support a registry with no local `skills/` directory.

Check committed output without writing files, and run the generator and SARIF tests:

```bash
node scripts/generate-manifest.mjs --check
node scripts/generate-readme.mjs --check
node --test scripts/*.test.mjs
```

## Lint skills

Skills are validated with [agnix](https://github.com/agent-sh/agnix). CI pins
version `v0.59.0`; use the same version locally:

```bash
npm install -g agnix@0.59.0
agnix .              # report errors and warnings
agnix --fix-safe .   # apply safe fixes only
agnix --strict .     # treat warnings as errors
```

`.github/workflows/agnix.yml` runs on pushes to main, on pull requests and on
manual dispatch. Validation errors fail the job. A filtered SARIF copy omits
findings without file locations so GitHub code scanning can accept the upload;
the original diagnostics and lint result are preserved. Upload failures are
nonfatal, and code scanning availability depends on repository settings.
`.agnix.toml` promotes credential exposure, dangerous execution and permission
escalation rules to errors, so those findings fail validation even without
`--strict`.

For agent-assisted remediation, use
[Fix skill diagnostics with agnix](.agents/prompts/fix-skills-using-agnix.md).
The prompt covers baseline checks, safe fixes, manual corrections and strict
validation, followed by regenerating the manifest and README catalog.

## Use with Nosey

Init creates the registry files; register it separately. From the project you want
to scan, run:

```bash
nosey registry add /path/to/my-registry
nosey scan .
```

For a published registry, use:

```bash
nosey registry add https://github.com/your-org/your-skills.git --ref main
```

Added registries are saved globally and available across projects. Existing
project-scoped references still load; use `registry remove <source> --project` to
remove a legacy reference. For a single scan without saving a reference, run
`nosey scan . --registry /path/to/my-registry`.

Validate a registry with `nosey registry validate /path/to/my-registry`. To check
whether its manifest is up to date, run
`node scripts/generate-manifest.mjs --check` and
`node scripts/generate-readme.mjs --check` from the registry directory.

Only the registry JSON files are interpreted by Nosey; skill files are
never executed or installed during detection.

## Schema annotations and validation

`skills-manifest.json` and `skills-map.json` start with a relative `$schema` annotation
that points at a copy of the contract shipped here:

- [skills-manifest.schema.json](schemas/skills-manifest.schema.json)
- [skills-map.schema.json](schemas/skills-map.schema.json)

Editors use the annotation for completion and field diagnostics. Nosey ignores it, and
every writer in this template preserves it verbatim — including a custom value — while a
registry that ships no `schemas/` directory keeps its documents unannotated. Delete the
annotation if you do not want it.

The schemas are structural only. Uniqueness by property, regular-expression compilation,
path normalization, GitHub source spelling, `registryId` agreement, skill file existence,
and dangling references are parser or integration rules that a JSON Schema cannot express.
A document can therefore be schema-valid and still be rejected by
`nosey registry validate`, and a schema-valid registry is only fully valid once that
command accepts it. The
[registry schema reference](https://github.com/rigerc/nosey/blob/main/docs/registry-schema.md)
lists every field, the separate rules for generated local IDs and three-segment external
IDs, and the three validity levels.

CI in this template stays dependency-free. It runs the generator tests and both `--check`
modes on pushes and pull requests that touch the registry documents, skills, or `schemas/`
and it does not install Nosey or a JSON Schema validator. It therefore checks generated
output only — not schema conformance and not full registry validity.
