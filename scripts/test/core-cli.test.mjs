import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNode22, defaultRoot, parseOptions} from '../lib/cli.mjs';

test('standalone CLI helpers resolve defaults from module and reject bad options', () => {
  assert.equal(defaultRoot(new URL('../generate.mjs', import.meta.url).href), new URL('../../', import.meta.url).pathname.replace(/\/$/, ''));
  assert.throws(() => parseOptions(['--root'], {root: '/tmp', usage: 'Usage'}), /requires a directory/);
  assert.throws(() => parseOptions(['--wat'], {root: '/tmp', usage: 'Usage'}), /unknown or unexpected/);
  assertNode22();
});
