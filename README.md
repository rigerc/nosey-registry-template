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
node scripts/check.mjs
```

Use Node.js 22 or newer. The registry requires no `package.json`, npm, `node_modules`, installation, or build step. The `.mjs` CLIs use Node built-ins and relative modules, and each CLI checks the Node version. Configuration rewrites the declared local identity, preserves external skill IDs and custom `$schema` annotations, regenerates the manifest and README catalog, and installs the canonical downstream `AGENTS.md` only when the existing guide is the verified template maintainer guide. A user-authored guide is preserved. The operation is safe to repeat with the same identity.

Validation fetches the two latest public Nosey schemas on every run and fails closed when fetching or evaluating them. It never follows a registry document's `$schema` value. `--schemas dir` supplies local schemas for explicit tests and CI fixtures only.

Add skills under `skills/<name>/SKILL.md`; nested skill directories are supported. Edit `skills-map.json` to associate local or declared external skills with technologies and combinations. Then regenerate and check the committed outputs:

```sh
node scripts/generate.mjs
node scripts/generate.mjs --check
node scripts/validate-registry.mjs
node --test
node scripts/check.mjs
```

Individual generator commands remain supported: `node scripts/generate-manifest.mjs` and `node scripts/generate-readme.mjs`. Every CLI defaults its root to the script location; `--root` and `--schemas` paths are resolved from the caller's current directory. `node scripts/configure-registry.mjs owner/repo [--root dir] [--schemas dir]` configures identity.

Use `node scripts/skills-map-cli.mjs` for mapping edits and [.agents/prompts/map-skills.md](.agents/prompts/map-skills.md) for the workflow. `discover` previews exact local skill IDs, including nested paths, from a read-only manifest preview. `validate` uses live schemas plus parser and integration checks; `add`/`remove`/`set` are idempotent, and `batch` applies a JSON array of operations as one validated write. `--dry-run` prints the proposed map, `--json` emits one machine-readable document per command with stable exit codes, `--interactive` walks the sections with numbered prompts, and `set registry-id` remaps local reference prefixes. The editor preserves schema annotations and unrelated fields, refuses invalid results, and writes atomically; the committed manifest and README stay untouched until you run the generators.

The manifest reader extracts only `name` and `description`; it is not a general YAML validator. Quote values that look like numbers, booleans, `null`, or timestamps. Ambiguous or unsupported values may be treated as absent, so a missing name falls back to the skill directory name and a missing description is omitted. Agnix validates skill frontmatter and content.

`node scripts/generate.mjs --check` is read-only. `node scripts/check.mjs` checks generated output, live schema validation, and tests; it does not run Agnix. Run `node scripts/run-agnix.mjs [--strict]` separately when skill content changes. Agnix is separately provisioned, never downloaded by these tools. See [Contributing](CONTRIBUTING.md) for the local commands.

The manual generation workflow is a safety net: its Actions UI defaults to `main`, honors the selected branch for checkout and push, and rejects tag refs. Manual runs bypass the last-bot loop guard; automatic relevant pushes remain limited to `main` and keep the guard. It commits only the generated manifest and README, and skips empty or force pushes.

## Receive template updates

Derived registries receive infrastructure updates through reviewed [template-sync pull requests](.github/workflows/template-sync.yml). Enable Actions and permit it to create pull requests. Add `TEMPLATE_SYNC_TOKEN` as a repository secret with only the repository's Contents, Pull requests, and Workflows write access; do not paste tokens into issues, chat, or files. The built-in `GITHUB_TOKEN` reads the public template; the secret authorizes writes to the derived repository, including workflow updates.

The workflow runs monthly or manually from the Actions tab. Manual runs select an upstream branch (default `main`) and can set `dry_run` to preview without pushing a branch or opening a pull request; the token is still required. Updates target the derived repository's default branch, use independent Git histories, and are never merged automatically. Inspect every proposed diff and require registry CI and Agnix before merging.

The action uses squash merge with `--allow-unrelated-histories --strategy=recursive -X theirs`, so upstream wins conflicts in synchronized files. Review local infrastructure edits on every proposal. Resolve any conflict markers on the PR branch before merging. `.templatesyncignore` is interpreted as Git pathspecs, not `.gitignore` syntax. It protects `skills/**`, `skills-map.json`, `skills-manifest.json`, `README.md`, `LICENSE`, root `AGENTS.md`, and optional downstream `package.json` and lockfiles; retain these exclusions and add local paths that must not be synchronized. Removing the former `my-skills` template wrapper is a separate migration. Upstream removal of its package metadata must not erase customized downstream package metadata or dependencies. The workflow requires a nonempty ignore file. For setup, preview, conflicts, or recovery, follow [Contributing](CONTRIBUTING.md#review-template-sync-updates).

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

Nosey owns the runtime and registry schema contract. This repository owns the template tooling and its documentation. Schema changes begin in Nosey; update the template's bounded validator and tests in the reviewed compatibility sequence. The template uses Node.js built-ins and relative modules on Node.js 22 or newer, with no required package manifest, dependencies, install, or build step. The template-sync workflow proposes infrastructure changes; it does not publish or merge them automatically.

This template adapts repository practices from [ianlewis/repo-template](https://github.com/ianlewis/repo-template). See [NOTICE.md](NOTICE.md) for attribution and [LICENSE](LICENSE) for licensing terms.
