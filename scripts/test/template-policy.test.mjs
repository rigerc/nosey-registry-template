import assert from 'node:assert/strict';
import test from 'node:test';
import {actionReferences, isPinnedActionReference} from '../lib/template-policy.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';

test('action references include values with YAML comments and quoted scalars', () => {
  const refs = actionReferences([
    `      - uses: actions/checkout@${sha} # v4`,
    `        uses: "actions/setup-node@${sha}" # pinned release`,
    `        uses: 'vendor/action@${sha}'`,
    '        run: echo "# not a comment in this scalar"',
  ].join('\n'));
  assert.deepEqual(refs, [
    `actions/checkout@${sha}`,
    `actions/setup-node@${sha}`,
    `vendor/action@${sha}`,
  ]);
  assert.ok(refs.every(isPinnedActionReference));
});

test('mutable action refs remain visible when followed by YAML comments', () => {
  const refs = actionReferences('        uses: AndreasAugustin/actions-template-sync@v2.6.0 # upstream release\n');
  assert.deepEqual(refs, ['AndreasAugustin/actions-template-sync@v2.6.0']);
  assert.equal(isPinnedActionReference(refs[0]), false);
});
