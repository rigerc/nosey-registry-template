# Contributing

This repository is a template for Nosey skill registries. Changes to the template tooling and workflows belong here; Nosey owns registry runtime behavior and schemas. Preserve the separation between template infrastructure and downstream-owned registry content.

## Registry changes

1. Use Node.js 22 or newer. The registry requires no `package.json`, npm, `node_modules`, install, or build step. CLIs reject unsupported Node versions and use built-ins plus relative modules.
2. Add or update skill files under `skills/` and mappings in `skills-map.json`. Agnix separately validates skill quality; generators only extract manifest metadata.
3. Run `node scripts/generate.mjs` and include the generated manifest and marker-delimited README catalog in the same change. Individual generators remain available as `node scripts/generate-manifest.mjs` and `node scripts/generate-readme.mjs`.
4. Run `node scripts/generate.mjs --check`, `node scripts/validate-registry.mjs`, `node --test`, `node scripts/check.mjs`, and `git diff --check`. `check` is read-only and does not run Agnix.
5. Provision Agnix separately and run `node scripts/run-agnix.mjs [--strict]` when skill content changes. This command never downloads Agnix. CI uses the separately pinned release.

The CLIs default `--root` to the script location. Values supplied to `--root` and `--schemas` are resolved relative to the caller's current working directory. Validation normally fetches live schemas and fails closed on network, HTTP, parse, or unsupported-keyword errors. `--schemas dir` is for explicit local test fixtures only.

For mapping changes, use [.agents/prompts/map-skills.md](.agents/prompts/map-skills.md) and `node scripts/skills-map-cli.mjs`. `discover` previews exact local skill IDs through a read-only manifest preview; `validate` checks the map against live schemas plus parser and integration rules; `add`/`remove`/`set` edit every section idempotently; `--interactive` walks the sections with numbered prompts. Prefer one `batch <operations.json>` transaction so related declarations and references are validated together, preview it with `--dry-run`, and use `--json` for one machine-readable document per command. `set registry-id` remaps local reference prefixes, but `configure-registry.mjs` remains the full identity migration. Regenerate the manifest and catalog as a separate step before committing.

The manifest generator reads only `name` and `description`; it is not a general YAML validator. Quote values that resemble numbers, booleans, `null`, or timestamps. Ambiguous or unsupported values may be treated as absent: names then fall back to the skill directory, and descriptions are omitted. Agnix owns frontmatter and skill-content validation.

Schema validation fetches the latest manifest and map schemas from Nosey's fixed public `main` URLs on each run. Network, HTTP, schema parse, or unsupported-keyword failures stop validation; there is no cache or fallback. Explicit `--schemas <dir>` overrides are for test/CI fixtures only. Instance `$schema` annotations are preserved but never dereferenced by the validator.

The CI workflow always checks generated output, live registry validation, and tests without installing packages. Agnix runs for `skills/**` changes, and manual dispatch forces the audit. The manual generation workflow defaults to `main` in the Actions UI, honors the selected branch for checkout and push, and rejects tag refs. Manual runs bypass the last-bot loop guard; automatic relevant pushes remain limited to `main` and retain the guard. It commits only generated manifest and README files, with no empty or force push. Pull requests must include generated output already.

## Review template sync updates

Derived registries use the reviewed [template-sync workflow](.github/workflows/template-sync.yml) to receive infrastructure updates across the independent Git histories created by GitHub templates. Enable Actions and allow it to create pull requests. Configure `TEMPLATE_SYNC_TOKEN` as a repository secret with Contents, Pull requests, and Workflows write permissions for that repository. A fine-grained token should be limited to the target repository; a classic token needs repository access and the `workflow` scope. Workflow permission is needed because synchronized updates can change `.github/workflows/`. The built-in `GITHUB_TOKEN` reads the public template; the custom secret authorizes writes to the derived repository. Never share a token in chat or commit it to a file.

The workflow targets the derived repository's default branch. It runs monthly, or manually with an upstream branch (default `main`) and optional `dry_run`. A dry run prepares the update without pushing a branch or opening a pull request, but still requires the token. To preview from a checkout, run:

```sh
gh workflow run template-sync.yml -f ref=main -F dry_run=true
```

Inspect the Actions log and proposed diff. The action uses squash merge with `--allow-unrelated-histories --strategy=recursive -X theirs`: upstream wins conflicting edits in synchronized files. Resolve any conflict markers on the proposed branch and review local infrastructure customizations before merging. Sync branches are named `automation/nosey-template-sync_<upstream-short-hash>`; an existing branch for a revision is skipped, while a newer revision can create another pull request. Updates are never auto-merged. Require registry CI and Agnix before merging.

`.templatesyncignore` is consumed as Git pathspecs, not `.gitignore` patterns. Keep exclusions for downstream-owned `skills/**`, `skills-map.json`, `skills-manifest.json`, `README.md`, `LICENSE`, root `AGENTS.md`, and optional downstream `package.json` and lockfiles; add local paths that must remain downstream-owned. Preserve customized package metadata and dependencies when upstream removes its package files. Removing the former `my-skills` wrapper is a separate migration. The workflow refuses to run without a nonempty ignore file. When adopting the workflow, copy `.github/workflows/template-sync.yml` and `.templatesyncignore` from the template while preserving local exclusions. The ignore file itself is downstream-owned, so future template changes do not update existing copies.

If a sync fails or leaves conflicts, keep the proposed branch for inspection, resolve conflicts there, and rerun applicable checks before merging. Do not delete a derived repository or discard downstream content as a recovery shortcut. For a registry that used the former custom updater, remove its updater scripts/state and old baseline check only after reviewing the new workflow and preserving any local exclusions. Follow the documented checks with Node.js 22 or newer after checkout as applicable, and skip removed Make targets. Preserve source attribution and security escalations when adapting repository materials.
