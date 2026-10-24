# Contributing

This repository is a template for Nosey skill registries. Changes to the template tooling and workflows belong here; Nosey owns registry runtime behavior and schemas. Preserve the separation between template infrastructure and downstream-owned registry content.

## Registry changes

1. Use Node.js 22 or newer. The template uses Node built-ins and requires no `npm ci`, `npm install`, or other dependency installation.
2. Add or update skill files under `skills/` and mappings in `skills-map.json`. Agnix separately validates skill quality; generators only extract manifest metadata.
3. Run `npm run generate` and include the generated manifest and marker-delimited README catalog in the same change.
4. Run `npm run generate:check`, `npm run validate`, `npm test`, `npm run check`, and `git diff --check`. `check` is read-only and does not run agnix.
5. Provision agnix separately and run `npm run lint` (or `npm run lint:strict`) when skill content changes. These commands do not install agnix. CI uses the separately pinned agnix release.

The manifest generator reads only `name` and `description`; it is not a general YAML validator. Quote values that resemble numbers, booleans, `null`, or timestamps. Ambiguous or unsupported values may be treated as absent: names then fall back to the skill directory, and descriptions are omitted. Agnix owns frontmatter and skill-content validation.

Schema validation fetches the latest manifest and map schemas from Nosey's fixed public `main` URLs on each run. Network, HTTP, schema parse, or unsupported-keyword failures stop validation; there is no cache or fallback. Explicit `--schemas <dir>` overrides are for test/CI fixtures only. Instance `$schema` annotations are preserved but never dereferenced by the validator.

The CI workflow always checks generated output, live registry validation, and tests without installing packages. Agnix runs for `skills/**` changes, and manual dispatch forces the audit. The generation workflow commits manifest and README updates on `main` as a safety net; pull requests must include generated output already.

## Review template sync updates

Derived registries use the reviewed [template-sync workflow](.github/workflows/template-sync.yml) to receive infrastructure updates across the independent Git histories created by GitHub templates. Enable Actions and allow it to create pull requests. Configure `TEMPLATE_SYNC_TOKEN` as a repository secret with Contents, Pull requests, and Workflows write permissions for that repository. A fine-grained token should be limited to the target repository; a classic token needs repository access and the `workflow` scope. Workflow permission is needed because synchronized updates can change `.github/workflows/`. The built-in `GITHUB_TOKEN` reads the public template; the custom secret authorizes writes to the derived repository. Never share a token in chat or commit it to a file.

The workflow targets the derived repository's default branch. It runs monthly, or manually with an upstream branch (default `main`) and optional `dry_run`. A dry run prepares the update without pushing a branch or opening a pull request, but still requires the token. To preview from a checkout, run:

```sh
gh workflow run template-sync.yml -f ref=main -F dry_run=true
```

Inspect the Actions log and proposed diff. The action uses squash merge with `--allow-unrelated-histories --strategy=recursive -X theirs`: upstream wins conflicting edits in synchronized files. Resolve any conflict markers on the proposed branch and review local infrastructure customizations before merging. Sync branches are named `automation/nosey-template-sync_<upstream-short-hash>`; an existing branch for a revision is skipped, while a newer revision can create another pull request. Updates are never auto-merged. Require registry CI and Agnix before merging.

`.templatesyncignore` is consumed as Git pathspecs, not `.gitignore` patterns. Keep the downstream-owned exclusions for `skills/**`, `skills-map.json`, `skills-manifest.json`, `README.md`, `LICENSE`, and root `AGENTS.md`; add local paths there when they must remain downstream-owned. The workflow refuses to run without a nonempty ignore file. When adopting the workflow, copy `.github/workflows/template-sync.yml` and `.templatesyncignore` from the template while preserving local exclusions. The ignore file itself is downstream-owned, so future template changes do not update existing copies.

If a sync fails or leaves conflicts, keep the proposed branch for inspection, resolve conflicts there, and rerun applicable checks before merging. Do not delete a derived repository or discard downstream content as a recovery shortcut. For a registry that used the former custom updater, remove its updater scripts/state and old baseline check only after reviewing the new workflow and preserving any local exclusions. Follow the documented Node 22 checks after checkout as applicable, and skip removed Make targets. Preserve source attribution and security escalations when adapting repository materials.
