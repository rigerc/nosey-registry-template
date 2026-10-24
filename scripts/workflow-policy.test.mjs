import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {detectSkillChanges} from './detect-skill-changes.mjs';
import {shouldGenerate} from './generation-policy.mjs';

function git(directory, ...args) {
  const result = spawnSync('git', args, {cwd: directory, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nosey-workflow-events-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'Workflow tests');
  git(directory, 'config', 'user.email', 'workflow-tests@example.invalid');
  git(directory, 'config', 'core.hooksPath', '/dev/null');
  mkdirSync(join(directory, 'skills'), {recursive: true});
  writeFileSync(join(directory, 'README.md'), 'base\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'base');
  const base = git(directory, 'rev-parse', 'HEAD');
  return {directory, base};
}

function commitFile(directory, path, contents, message) {
  const target = join(directory, path);
  mkdirSync(join(target, '..'), {recursive: true});
  writeFileSync(target, contents);
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', message);
  return git(directory, 'rev-parse', 'HEAD');
}

test('workflow changes detection audits manual, initial and unresolvable events', (t) => {
  const {directory, base} = repository(t);
  const head = commitFile(directory, 'README.md', 'new\n', 'docs');
  assert.equal(detectSkillChanges({eventName: 'workflow_dispatch', cwd: directory}).skills, true);
  assert.equal(detectSkillChanges({eventName: 'push', baseSha: '0'.repeat(40), headSha: head, cwd: directory}).skills, true);
  assert.equal(detectSkillChanges({eventName: 'push', baseSha: 'f'.repeat(40), headSha: head, cwd: directory}).skills, true);
  assert.equal(detectSkillChanges({eventName: 'push', baseSha: base, headSha: 'invalid', cwd: directory}).skills, true);
});
test('push and PR comparisons detect skill edits, deletions, renames and no-change commits', (t) => {
  const {directory, base} = repository(t);
  const first = commitFile(directory, 'skills/one/SKILL.md', 'one', 'add skill');
  assert.equal(detectSkillChanges({eventName: 'push', baseSha: base, headSha: first, cwd: directory}).skills, true);

  const second = commitFile(directory, 'skills/two/SKILL.md', 'two', 'second skill');
  assert.equal(detectSkillChanges({eventName: 'pull_request', baseSha: base, headSha: second, cwd: directory}).skills, true);

  git(directory, 'rm', 'skills/one/SKILL.md');
  mkdirSync(join(directory, 'docs'), {recursive: true});
  git(directory, 'mv', 'skills/two/SKILL.md', 'docs/SKILL.md');
  git(directory, 'commit', '-qm', 'rename and delete skills');
  const renameDelete = git(directory, 'rev-parse', 'HEAD');
  assert.equal(detectSkillChanges({eventName: 'push', baseSha: second, headSha: renameDelete, cwd: directory}).skills, true);

  const docs = commitFile(directory, 'README.md', 'docs changed\n', 'docs only');
  assert.equal(detectSkillChanges({eventName: 'push', baseSha: renameDelete, headSha: docs, cwd: directory}).skills, false);
  assert.equal(detectSkillChanges({eventName: 'pull_request', baseSha: base, headSha: base, cwd: directory}).skills, false);
});

test('PR detection uses the merge base and fails closed when histories diverge', (t) => {
  const {directory, base} = repository(t);
  git(directory, 'checkout', '-qb', 'feature');
  const head = commitFile(directory, 'README.md', 'feature docs\n', 'feature docs');
  git(directory, 'checkout', '-q', 'main');
  const upstream = commitFile(directory, 'skills/upstream/SKILL.md', 'skill', 'upstream skill');
  assert.equal(detectSkillChanges({eventName: 'pull_request', baseSha: upstream, headSha: head, cwd: directory}).skills, false);
  assert.equal(detectSkillChanges({eventName: 'pull_request', baseSha: 'f'.repeat(40), headSha: head, cwd: directory}).skills, true);
  assert.equal(base.length, 40);
});

test('generation policy is push-to-main only and prevents bot commit loops', () => {
  assert.equal(shouldGenerate({eventName: 'workflow_dispatch', ref: 'refs/heads/main'}), false);
  assert.equal(shouldGenerate({eventName: 'pull_request', ref: 'refs/heads/main'}), false);
  assert.equal(shouldGenerate({eventName: 'push', ref: 'refs/heads/feature'}), false);
  assert.equal(shouldGenerate({eventName: 'push', ref: 'refs/heads/main', headMessage: 'update skills'}), true);
  assert.equal(shouldGenerate({eventName: 'push', ref: 'refs/heads/main', headMessage: 'chore(registry): update skill manifest and catalog'}), false);
});

test('workflow files keep required checks event-wide and gate only the agnix job', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const generation = readFileSync(new URL('../.github/workflows/generate.yml', import.meta.url), 'utf8');
  assert.match(ci, /pull_request:\n\s+push:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(ci, /^\s+paths:/m);
  assert.match(ci, /if: needs\.changes\.outputs\.skills == 'true'/);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(ci, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(ci, /agent-sh\/agnix@182f69774807d9df7c82dcde8240ca0c595e7c83/);
  assert.match(ci, /version: v0\.59\.1/);
  assert.match(ci, /github\/codeql-action\/upload-sarif@4bfa242aa49c5f7c6770b98670d354a7dfac05f8/);
  assert.match(ci, /continue-on-error: true/);
  assert.match(ci, /registry:\n[\s\S]*?npm run generate:check[\s\S]*?npm run validate[\s\S]*?npm test[\s\S]*?git diff --exit-code/);
  assert.match(generation, /branches: \[main\]/);
  assert.match(generation, /skills\/\*\*/);
  assert.match(generation, /skills-map\.json/);
  assert.match(generation, /scripts\/generate-(?:manifest|readme)\.mjs/);
  assert.match(generation, /git add -- skills-manifest\.json README\.md/);
  assert.doesNotMatch(generation, /pull_request:/);
});
