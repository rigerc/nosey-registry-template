# Template synchronization

Derived registries receive infrastructure updates through reviewed pull requests from
[actions-template-sync](https://github.com/AndreasAugustin/actions-template-sync), pinned
to v2.6.0 in [the workflow](.github/workflows/template-sync.yml). The action supports
the independent Git histories created by GitHub templates.

[`.templatesyncignore`](.templatesyncignore) protects downstream-owned `skills/**`,
`registry.json`, `skills-map.json`, `skills-manifest.json`, `README.md` and `LICENSE`.
Other template files, including scripts, workflows, repository standards and this guide,
can receive updates. Review the proposed diff before merging.

## Enable automatic update pull requests

1. Enable GitHub Actions in the derived repository and permit Actions to create PRs.
2. Add the repository secret `TEMPLATE_SYNC_TOKEN` with Contents, Pull requests and
   Workflows write permissions for the derived repository. A fine-grained PAT needs
   access to that repository; a classic PAT needs the appropriate repository access
   and `workflow` scope. Workflow write access is needed because updates include
   `.github/workflows/`. The built-in `GITHUB_TOKEN` reads the public template; the
   custom token checks out and writes to the derived repository.
3. Run **Update from Nosey registry template** from the Actions tab, or wait for the
   monthly schedule (04:17 UTC on the first day of each month).

The workflow always targets the derived repository's default branch. Manual runs accept
an upstream template branch through `ref` (default: `main`); tags and commit hashes are
not supported by this selector. The template repository itself skips the sync job.

The action creates branches named `automation/nosey-template-sync_<upstream-short-hash>`.
An existing branch for the same revision is skipped. New revisions can produce new PRs;
older PRs and branches are left for maintainers to close. Updates are never auto-merged.

## Preview and review updates

Select `dry_run` when dispatching the workflow to prepare changes without pushing a
branch or creating a PR. With the GitHub CLI, run:

```bash
gh workflow run template-sync.yml -f ref=main -F dry_run=true
```

Inspect the Actions logs, then run again with `dry_run=false` to propose the update.
The token is required for dry runs too. After checking out the proposed PR locally, run:

```bash
make generate
make check
git diff
```

Commit regenerated artifacts to the PR branch if needed. Require registry CI and
Agnix before merging.

## Customizations and conflicts

The action uses a squash merge with `--allow-unrelated-histories --strategy=recursive -X theirs`.
**Upstream wins conflicting edits in synchronized files.** Review your local
infrastructure customizations in every PR. The action may leave conflict markers for
conflicts Git cannot resolve automatically; resolve those on the proposed branch before
merging. This differs from the former updater, which stopped before writing any changes
when a conflict occurred.

The ignore file uses Git pathspecs, as described in the
[action's ignore documentation](https://github.com/AndreasAugustin/actions-template-sync#ignore-files).
It is restored before excluded files are reset, so an existing downstream ignore file
is preserved. Edit and commit your downstream copy directly to protect additional paths.
Template changes to this file do not automatically update existing copies; keep the
registry-owned exclusions when adopting changes. The workflow refuses to sync without
a nonempty `.templatesyncignore`; copy and commit it before the first run.

## Migrate from the custom updater

Existing registries should copy the new `.github/workflows/template-sync.yml` and
`.templatesyncignore` from the template, preserving any local exclusions. Keep the
existing `TEMPLATE_SYNC_TOKEN` secret. Remove `scripts/template-update.mjs`,
`scripts/template-update.test.mjs`, `scripts/template-state.mjs`, `.template/state.json`,
the `template-state` Makefile target and the upstream baseline check in registry CI.
The action uses Git directly and no longer needs baseline hashes or a local updater.

Template maintainers can commit infrastructure changes normally; `make template-state`
is no longer needed. Run `make check` before publishing template changes.
