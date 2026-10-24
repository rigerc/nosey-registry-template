import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {assertNode22, defaultRoot} from '../lib/cli.mjs';

const repo = defaultRoot(new URL('../generate.mjs', import.meta.url).href);
const scripts = path.join(repo, 'scripts');
const toolFiles = [
  'check.mjs', 'configure-registry.mjs', 'generate-manifest.mjs', 'generate-readme.mjs', 'generate.mjs', 'run-agnix.mjs', 'validate-registry.mjs',
];

function snapshot(dir) {
  const names = ['AGENTS.md', 'README.md', 'skills-map.json', 'skills-manifest.json'];
  return Object.fromEntries(names.map((name) => [name, readFileSync(path.join(dir, name))]));
}

function run(node, script, args, cwd, pathEnv) {
  const env = {...process.env, PATH: pathEnv, NOSEY_DISCOVERY_MARKER: path.join(path.dirname(cwd), 'nested test discovered')};
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(node, [script, ...args], {cwd, encoding: 'utf8', env});
}

test('Node guard rejects unsupported majors without running at import time', async () => {
  assertNode22('22.0.0');
  assert.throws(() => assertNode22('23.0.0'), /Node\.js 22 is required/);
  assert.throws(() => assertNode22('24.1.0'), /Node\.js 22 is required/);
  const imported = await import('../generate.mjs');
  assert.ok(imported);
});

test('standalone CLIs work from foreign CWD with spaced paths and no npm or git', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'standalone registry '));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const root = path.join(temp, 'clone with spaces');
  const cwd = path.join(temp, 'caller cwd');
  const bin = path.join(temp, 'empty PATH');
  const relativeRoot = path.relative(cwd, root);
  mkdirSync(root, {recursive: true});
  mkdirSync(cwd);
  mkdirSync(bin);
  const cloneScripts = path.join(root, 'scripts');
  mkdirSync(cloneScripts);
  for (const name of toolFiles) cpSync(path.join(scripts, name), path.join(cloneScripts, name));
  cpSync(path.join(scripts, 'lib'), path.join(cloneScripts, 'lib'), {recursive: true, filter: (source) => !source.endsWith('.test.mjs')});
  mkdirSync(path.join(cloneScripts, 'test', 'nested'), {recursive: true});
  writeFileSync(path.join(cloneScripts, 'test', 'nested', 'discovery.test.mjs'), "import test from 'node:test'; import {writeFileSync} from 'node:fs'; writeFileSync(process.env.NOSEY_DISCOVERY_MARKER, 'ran'); test('nested suite discovered by check', () => {});\n");
  // Use a small, stable registry that cannot inherit stale generated output or
  // skill inventory from whichever checkout runs this infrastructure test.
  cpSync(path.join(repo, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
  writeFileSync(path.join(root, 'README.md'), '# Fixture registry\n\n<!-- BEGIN GENERATED SKILL CATALOG -->\n<!-- END GENERATED SKILL CATALOG -->\n');
  writeFileSync(path.join(root, 'skills-map.json'), `${JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json',
    schemaVersion: 2,
    registryId: 'fixture/registry',
    alwaysRecommend: [], externalSkills: [], technologies: [], technologySkills: [],
    combinations: [], combinationSkills: [], frontendBonusSkills: [], frontendPackages: [], webFrontendExtensions: [],
  }, null, 2)}\n`);
  mkdirSync(path.join(root, 'skills', 'alpha'), {recursive: true});
  mkdirSync(path.join(root, 'skills', 'nested', 'beta'), {recursive: true});
  writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: Alpha fixture\ndescription: Stable populated fixture skill.\n---\n\nFixture content.\n');
  writeFileSync(path.join(root, 'skills', 'nested', 'beta', 'SKILL.md'), '---\nname: Beta fixture\ndescription: Nested populated fixture skill.\n---\n\nFixture content.\n');
  mkdirSync(path.join(root, '.agents', 'templates'), {recursive: true});
  cpSync(path.join(repo, '.agents', 'templates', 'registry-AGENTS.md'), path.join(root, '.agents', 'templates', 'registry-AGENTS.md'));
  const schemas = path.join(cwd, 'schema fixtures');
  mkdirSync(schemas);
  writeFileSync(path.join(schemas, 'skills-manifest.schema.json'), '{"type":"object"}\n');
  writeFileSync(path.join(schemas, 'skills-map.schema.json'), '{"type":"object"}\n');
  const marker = path.join(temp, 'install-script-ran');
  const packageBytes = Buffer.from(JSON.stringify({type: 'commonjs', scripts: {preinstall: `node -e \"require('fs').writeFileSync('${marker}', 'bad')\"`, postinstall: `node -e \"require('fs').writeFileSync('${marker}', 'bad')\"`}}));
  writeFileSync(path.join(root, 'package.json'), packageBytes);
  const envPath = bin;
  const generate = path.join(cloneScripts, 'generate.mjs');
  const configure = path.join(cloneScripts, 'configure-registry.mjs');
  const check = path.join(cloneScripts, 'check.mjs');
  let result;

  // Seed canonical generated outputs from the fixture itself; do not copy
  // generated files from the live checkout under test.
  result = run(process.execPath, generate, [], cwd, envPath);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'skills-manifest.json'), 'utf8')).skills.map((skill) => skill.path), [
    'skills/alpha/SKILL.md', 'skills/nested/beta/SKILL.md',
  ]);

  // No --root: the CLI must find its own copied checkout from a foreign CWD.
  result = run(process.execPath, generate, ['--check'], cwd, envPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Generated files are current/);

  // Both relative overrides are resolved from the caller's CWD, including spaces.
  result = run(process.execPath, configure, ['owner/repo', '--root', relativeRoot, '--schemas', 'schema fixtures'], cwd, envPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured registry owner\/repo/);
  result = run(process.execPath, generate, ['--root', relativeRoot], cwd, envPath);
  assert.equal(result.status, 0, result.stderr);
  result = run(process.execPath, check, ['--root', relativeRoot, '--schemas', 'schema fixtures'], cwd, envPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(temp, 'nested test discovered'), 'utf8'), 'ran', `check must discover nested tests; ${result.stdout} ${result.stderr}`);
  const before = snapshot(root);
  result = run(process.execPath, check, ['--root', relativeRoot, '--schemas', 'schema fixtures'], cwd, envPath);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(root), before, 'read-only check must preserve output bytes');

  for (const [script, args] of [
    [generate, ['--unknown']],
    [configure, ['owner/repo', '--schemas']],
    [check, ['--root', relativeRoot, '--surprise']],
  ]) assert.notEqual(run(process.execPath, script, args, cwd, envPath).status, 0);

  result = run(process.execPath, path.join(cloneScripts, 'run-agnix.mjs'), ['--root', relativeRoot], cwd, envPath);
  assert.equal(result.status, 127, result.stderr);
  assert.equal(existsSync(marker), false, 'package scripts must not execute');
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
  assert.deepEqual(readFileSync(path.join(root, 'package.json')), packageBytes, 'optional package metadata is untouched');
});
