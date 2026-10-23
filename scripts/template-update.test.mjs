import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {managed, update} from './template-update.mjs';

function git(cwd, ...args) {
  const run = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'template-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), child = path.join(root, 'child');
  await mkdir(source);
  await mkdir(child);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'test');
  git(source, 'config', 'user.email', 'test@example.com');
  for (const repo of [source, child]) {
    await mkdir(path.join(repo, 'scripts'), {recursive: true});
    await writeFile(path.join(repo, 'scripts/check.mjs'), 'export const version = 1;\n');
    await writeFile(path.join(repo, 'Makefile'), 'check:\n\techo base\n');
  }
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'baseline');
  const original = git(source, 'rev-parse', 'HEAD');
  await mkdir(path.join(child, '.template'));
  await writeFile(path.join(child, '.template/state.json'), JSON.stringify({
    schemaVersion: 1, source: 'rigerc/nosey-registry-template', sourceRevision: original,
  }));
  await writeFile(path.join(child, 'skills-map.json'), '{"downstream":true}\n');
  await writeFile(path.join(child, 'README.md'), '# Registry-owned\n');
  return {source, child, original};
}
test('ownership policy never includes user registry content', () => {
  for (const name of ['registry.json', 'skills-map.json', 'skills-manifest.json', 'README.md',
    'skills/nested/SKILL.md', '.template/state.json', '../unsafe']) assert.equal(managed(name), false);
  for (const name of ['scripts/manifest.mjs', 'Makefile', '.github/workflows/ci.yml']) assert.equal(managed(name), true);
});
test('upstream changes apply while registry data remains unchanged; repeat is idempotent', async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.source, 'scripts/check.mjs'), 'export const version = 2;\n');
  await writeFile(path.join(f.source, 'scripts/new.mjs'), 'export const next = true;\n');
  git(f.source, 'add', '.');
  git(f.source, 'commit', '-qm', 'new tooling');
  const outcome = await update({root: f.child, source: f.source});
  assert.deepEqual(outcome.updated, ['scripts/check.mjs', 'scripts/new.mjs']);
  assert.equal(await readFile(path.join(f.child, 'scripts/check.mjs'), 'utf8'), 'export const version = 2;\n');
  assert.equal(await readFile(path.join(f.child, 'README.md'), 'utf8'), '# Registry-owned\n');
  assert.equal(await readFile(path.join(f.child, 'skills-map.json'), 'utf8'), '{"downstream":true}\n');
  assert.deepEqual((await update({root: f.child, source: f.source})).updated, []);
});
test('conflicts prevent all changes and do not advance source revision', async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.source, 'Makefile'), 'check:\n\techo upstream\n');
  await writeFile(path.join(f.source, 'scripts/check.mjs'), 'export const version = 2;\n');
  git(f.source, 'add', '.');
  git(f.source, 'commit', '-qm', 'upstream');
  await writeFile(path.join(f.child, 'Makefile'), 'check:\n\techo local\n');
  await assert.rejects(update({root: f.child, source: f.source}), /Template merge conflicts/);
  assert.equal(await readFile(path.join(f.child, 'scripts/check.mjs'), 'utf8'), 'export const version = 1;\n');
  assert.equal(JSON.parse(await readFile(path.join(f.child, '.template/state.json'), 'utf8')).sourceRevision, f.original);
});
