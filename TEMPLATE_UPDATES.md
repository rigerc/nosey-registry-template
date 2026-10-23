# Template synchronization

Generated registries have independent Git histories. The updater changes only template-managed
files (scripts, GitHub workflows, Makefile, Agnix policy, and repository standards). It **never**
overwrites `skills/**`, `registry.json`, `skills-map.json`,
`skills-manifest.json` or `README.md`.

The committed `.template/state.json` holds the last upstream commit applied. Updates use that
commit as the base for three-way file merging. Non-overlapping downstream edits are kept.
Conflicts stop the entire update before any files are written or the provenance changes.
Repeated updates to the same revision are idempotent.

## Automatic update pull requests

Set a repository secret `TEMPLATE_SYNC_TOKEN` with Contents, Pull requests, and
Workflows write permission for this repository. This permission is required because updates
may change workflow YAML files. Use a narrowly scoped fine-grained PAT or automation identity.
The default `GITHUB_TOKEN` is not used to push workflows. Enable Actions and permit
Actions to create PRs.

The workflow runs monthly and can be dispatched with an upstream branch or immutable
release tag. It proposes a pull request; **no update is auto-merged**.

## Manual update

```bash
node scripts/template-update.mjs --ref main
make generate
make check
git diff
```

Review the result and commit it on a PR branch. Only committed generated output changes
should accompany the sync. The updater fetches template source with Git for file reads,
but does not run any code from that checkout. If the recorded upstream commit has been
removed from history, the updater fails rather than silently overwriting local files.

The updater itself is managed and therefore can receive upgrades. Template owners should
avoid rewriting the public template history.
