import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

test('sync ignore pathspecs preserve registry content while allowing infrastructure updates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'template-sync-ignore-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false', '-C', root, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  async function put(name, content) {
    await mkdir(path.dirname(path.join(root, name)), {recursive: true});
    await writeFile(path.join(root, name), content);
  }
  const policy = await readFile(new URL('../.templatesyncignore', import.meta.url), 'utf8');
  const ignored = policy.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
  const owned = ['README.md', 'LICENSE', 'AGENTS.md', 'skills-map.json', 'skills-manifest.json',
    'skills/.gitkeep', 'skills/example/SKILL.md', 'skills/nested/example/reference.md'];
  const infrastructure = ['scripts/template-sync.test.mjs', '.github/workflows/template-sync.yml',
    '.agnix.toml', 'CONTRIBUTING.md', '.agents/templates/registry-AGENTS.md'];

  git('init', '-q', '-b', 'main');
  for (const name of [...owned, ...infrastructure]) await put(name, 'downstream\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com',
    'commit', '-qm', 'downstream registry');
  for (const name of [...owned, ...infrastructure]) await put(name, 'upstream\n');
  await rm(path.join(root, 'LICENSE'));
  await put('skills/new/nested/SKILL.md', 'new upstream skill\n');
  await put('scripts/new.mjs', '// new infrastructure\n');
  git('add', '.');

  // The action consumes these as Git pathspecs when resetting excluded changes.
  git('reset', '--', ...ignored);
  git('clean', '-df');
  git('checkout', '--', '.');

  for (const name of owned) assert.equal(await readFile(path.join(root, name), 'utf8'), 'downstream\n', name);
  await assert.rejects(readFile(path.join(root, 'skills/new/nested/SKILL.md')), {code: 'ENOENT'});
  assert.deepEqual(git('diff', '--cached', '--name-only').split('\n'),
    [...infrastructure, 'scripts/new.mjs'].sort());
  for (const name of infrastructure) assert.equal(await readFile(path.join(root, name), 'utf8'), 'upstream\n', name);
});
