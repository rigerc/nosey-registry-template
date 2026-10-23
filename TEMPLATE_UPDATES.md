# Template synchronization

Generated registries have independent Git histories. The updater changes only template-managed
files (scripts, GitHub workflows, Makefile, Agnix policy, and repository standards). It **never**
overwrites `skills/**`, `registry.json`, `skills-map.json`,
`skills-manifest.json` or `README.md`.

The committed `.template/state.json` records the Git blob ID of each template-managed file.
These exact file versions form the base for three-way merging, including files added in the
same commit as the baseline. Non-overlapping downstream edits are kept.
Conflicts stop the entire update before any files are written or the provenance changes.
Repeated updates to the same revision are idempotent.

Successful updates also record the upstream commit applied. Legacy version 1 state files
remain supported and migrate to version 2 after a successful update. A legacy baseline may
already be stale; resolve any reported conflicts against the original template before retrying.

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
removed from history, or a recorded base blob is unavailable, the updater fails rather than
silently overwriting local files. Branches, including non-default branches, and release tags
are resolved from a bare upstream clone.

The updater itself is managed and therefore can receive upgrades. Template owners should
avoid rewriting the public template history.

## Upstream template maintenance

After changing managed files in `rigerc/nosey-registry-template`, run `make template-state`
and commit `.template/state.json` with those changes. Upstream CI checks that the recorded
blob IDs match the files being shipped. The state file excludes itself, so the baseline can
describe its own commit without a circular commit hash dependency.

Do not run `make template-state` in a downstream registry: its baseline must continue to
describe the upstream files, rather than absorbing local customizations. Ordinary
`make generate` and `make check` never replace the baseline.
