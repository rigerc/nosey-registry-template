# Nosey registry template

Create shareable AI agent skill registries for [Nosey](https://github.com/rigerc/nosey). This template includes generators, technology mappings, and validation workflows.

<!-- BEGIN GENERATED SKILL CATALOG -->

## Skill catalog

Registry: example/agent-skills · 0 skills.

Generated from [skills-manifest.json](skills-manifest.json) and [skills-map.json](skills-map.json). Edit those sources or skill frontmatter, then regenerate this section.

Recommendation conditions below are alternatives; matching any condition can recommend a skill. Technology detection is handled by Nosey.

No skills are registered.

<!-- END GENERATED SKILL CATALOG -->

## Create a GitHub registry (recommended)

1. Select **Use this template** → **Create a new repository** at
   [rigerc/nosey-registry-template](https://github.com/rigerc/nosey-registry-template).
   Choose your owner, repository name, and visibility.
2. Clone the new repository and set its registry identity:

   ```bash
   gh repo clone your-org/your-skills
   cd your-skills
   npm ci
   node scripts/configure-registry.mjs your-org/your-skills
   npm run check
   git add skills-map.json skills-manifest.json README.md
   git commit -m "chore(registry): set registry identity"
   git push
   ```

   **The configuration step is required.** GitHub template creation does not
   automatically replace `example/agent-skills`. The command rewrites registry
   and local skill IDs, preserves external skill IDs and `$schema` annotations,
   and regenerates the README catalog. It is safe to rerun.

   Validation reads Nosey's latest public schemas over the network; see
   [Registry validation](#registry-validation).

3. Add skills under `skills/<name>/SKILL.md`; edit `skills-map.json` to
   associate them with technologies. Run `npm run generate && npm run check`.
4. Register the published repository with Nosey:

   ```bash
   nosey registry add https://github.com/your-org/your-skills.git --ref main
   nosey scan .
   ```

New repositories have independent Git histories. The included
[template-sync workflow](.github/workflows/template-sync.yml) checks for
upstream changes and proposes them in pull requests for review.

## Receive template updates

Derived registries receive upstream infrastructure changes through reviewed
[template-sync PRs](.github/workflows/template-sync.yml) using
[actions-template-sync](https://github.com/AndreasAugustin/actions-template-sync).
Skills, identity, mappings, the manifest and README remain downstream-owned.
Configure the `TEMPLATE_SYNC_TOKEN` secret with Contents, Pull requests and
Workflows write permissions to enable monthly updates. The workflow file documents
setup, dry runs and conflict handling.

## Local registry creation

Nosey's existing command still creates a registry from its packaged scaffold
rather than this GitHub template:

```bash
nosey registry init ./my-registry --registry-id your-org/your-skills
```

The interactive wizard asks for confirmation and can optionally initialize
Git. For unattended creation without Git:

```bash
nosey registry init ./my-registry --registry-id your-org/your-skills --yes --no-git
```

The destination must not already exist. Until Nosey's CLI is refactored, its
`--github` mode also uses the older local-scaffold-and-push flow.

## Customize

1. If copied manually, set the unique `registryId` in `skills-map.json` and update
   skill ID references in the map to match. Init already does this for you. Nosey
   validates these files using their `schemaVersion`.
2. Add your own skills under
   `skills/<skill-name>/SKILL.md`, with YAML frontmatter containing a name and
   a description explaining when to use the skill. Nested skill folders are supported.
3. From the registry directory, run `node scripts/generate-manifest.mjs` to generate
   `skills-manifest.json` using the identity in `skills-map.json`.
4. Run `node scripts/generate-readme.mjs` to refresh the skill catalog, then commit
   both `skills-manifest.json` and `README.md`.
5. Maintain `skills-map.json` manually. The generators never edit it. Update
   mappings when you delete or rename skills. For agent-assisted mapping, use
   [Map skills to project signals](.agents/prompts/map-skills.md).
6. Push to GitHub. CI regenerates and commits `skills-manifest.json` and the README
   catalog when skills, registry identity, mappings or generators change on the
   default branch. Pull request CI regenerates the output without pushing to the
   contributor's branch. Local generation remains useful for reviewing changes
   before pushing.

The generation workflow uses the built-in `GITHUB_TOKEN` with Contents write permission;
enable GitHub Actions and allow its commits on the target branch. If branch protection
blocks bot pushes, run `npm run generate` and commit the output yourself. You can also
run the workflow manually from the Actions tab.

The template includes an empty `skills/` directory tracked by `.gitkeep`. Add skills
alongside it; the manifest generator ignores the placeholder.

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

Check committed output without writing files, and run the generator and validator tests:

```bash
npm run generate:check
npm test
```

## Lint skills

Skills are validated with [agnix](https://github.com/agent-sh/agnix). CI pins
version `v0.59.1`; use the same version locally:

```bash
npm install -g agnix@0.59.1
agnix .              # report errors and warnings
agnix --fix-safe .   # apply safe fixes only
agnix --strict .     # treat warnings as errors
```

CI runs agnix when `skills/**` changes; validation errors fail the job. A filtered SARIF copy omits
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

## Registry validation

Nosey is canonical for registry formats. `npm run validate` fetches the latest
[manifest schema](https://github.com/rigerc/nosey/blob/main/schemas/registry/skills-manifest.schema.json)
and [map schema](https://github.com/rigerc/nosey/blob/main/schemas/registry/skills-map.schema.json)
from Nosey's `main` branch on every run and validates the JSON using Ajv 2020-12.
The template keeps no schema copies or revision pins, so schema changes in Nosey
apply on the next validation run.

Install the validator with `npm ci`, then run `npm run validate` or `npm run check`.
Both require network access. The schemas are public; no GitHub token is required.

```bash
npm ci
npm run check
```

Fetch failures fail validation; an older schema is never used as a fallback.
The `$schema` annotations in the manifest and map point editors at Nosey's latest
schemas; the validator always uses its fixed canonical URLs and never follows an
annotation target.

This checks JSON Schema constraints plus registry integration rules: identity
agreement, skill file existence and path safety, unique IDs, reference resolution,
regex compilation, external source shape and MCP config paths. Run
`nosey registry validate .` for full validation. See Nosey's
[registry schema reference](https://github.com/rigerc/nosey/blob/main/docs/registry-schema.md)
for the supported fields.

Template CI regenerates output, validates the registry and runs the test suite. Run
`npm run check` locally before publishing registry changes.

## Repository standards

This template adapts repository practices from [ianlewis/repo-template](https://github.com/ianlewis/repo-template). See [NOTICE.md](NOTICE.md) for attribution, and review the included [LICENSE](LICENSE) before publishing independently authored skills. Run `npm run check` before publishing.
