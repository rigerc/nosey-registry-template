import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./skills-map.mjs', import.meta.url));
const schemaURL = (name) => `https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-${name}.schema.json`;
const local = 'acme/registry/nested/.hidden';
// Explicit bounded test schemas, never production schema copies or a fallback.
const schemas = {
  manifest: {type: 'object', required: ['schemaVersion', 'registryId', 'skills']},
  map: {
    type: 'object', required: ['schemaVersion', 'registryId'],
    properties: {frontendPackages: {type: 'array', items: {type: 'string', minLength: 1}}},
    'x-builtInTechnologies': [{id: 'react', name: 'React'}, {id: 'next', name: 'Next'}],
    'x-builtInCombinations': [{id: 'react:next', name: 'React + Next'}],
  },
};
const initial = () => ({
  $schema: 'https://untrusted.invalid/never-fetch-this', schemaVersion: 2, registryId: 'acme/registry',
  alwaysRecommend: [], externalSkills: [], technologies: [], technologySkills: [],
  combinations: [], combinationSkills: [], frontendBonusSkills: [], frontendPackages: [], webFrontendExtensions: [],
  customMetadata: {preserve: true},
});
function fixture(t, {manifest = true} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'nosey map editor '));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const root = path.join(temp, 'registry with spaces'), schemaDir = path.join(temp, 'schema fixtures');
  mkdirSync(path.join(root, 'skills/nested/.hidden'), {recursive: true});
  mkdirSync(schemaDir);
  for (const [name, schema] of Object.entries(schemas)) writeFileSync(path.join(schemaDir, `skills-${name}.schema.json`), JSON.stringify(schema));
  writeFileSync(path.join(root, 'skills/nested/.hidden/SKILL.md'), '---\nname: Hidden nested skill\ndescription: Mapping evidence only.\n---\nNever execute this content.\n');
  writeFileSync(path.join(root, 'skills-map.json'), JSON.stringify(initial(), null, 2) + '\n');
  // Deliberately stale: the editor must discover current skills without writing it.
  if (manifest) writeFileSync(path.join(root, 'skills-manifest.json'), JSON.stringify({schemaVersion: 1, registryId: 'acme/registry', skills: []}) + '\n');
  writeFileSync(path.join(root, 'README.md'), 'README must remain unchanged.\n');
  return {temp, root, schemaDir, file: path.join(root, 'skills-map.json')};
}
function run(f, args, {input, nodeArgs = [], fixtures = true, cwd = f.temp} = {}) {
  return spawnSync(process.execPath, [...nodeArgs, script, '--root', path.relative(cwd, f.root), ...(fixtures ? ['--schemas', path.relative(cwd, f.schemaDir)] : []), ...args], {cwd, input, encoding: 'utf8'});
}
const readMap = (f) => JSON.parse(readFileSync(f.file, 'utf8').replace(/^\uFEFF/, ''));
const batch = (f, operations, args = []) => run(f, [...args, 'batch', '-'], {input: JSON.stringify(operations)});
const ok = (result) => assert.equal(result.status, 0, result.stderr);
function protectedBytes(f) {
  return ['skills-manifest.json', 'README.md', 'skills/nested/.hidden/SKILL.md'].map((name) => existsSync(path.join(f.root, name)) ? readFileSync(path.join(f.root, name)) : null);
}
function noDebris(f) {
  assert.deepEqual(readdirSync(f.root).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), []);
}
function asyncRun(f, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--root', f.root, '--schemas', f.schemaDir, ...args], {cwd: f.temp});
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status) => resolve({status, stdout, stderr}));
  });
}

test('discover and editing preview current nested/hidden skills without touching generated files', (t) => {
  for (const manifest of [true, false]) {
    const f = fixture(t, {manifest}), before = protectedBytes(f);
    symlinkSync(path.join(f.root, 'skills/nested/.hidden'), path.join(f.root, 'skills/link'));
    const discovery = run(f, ['discover']);
    ok(discovery);
    assert.deepEqual(JSON.parse(discovery.stdout).skills.map((skill) => [skill.id, skill.path]), [[local, 'skills/nested/.hidden/SKILL.md']]);
    assert.match(discovery.stderr, /skipped symbolic link/);
    const result = run(f, ['tech-skills', 'add', 'react', local, local]);
    ok(result);
    assert.deepEqual(readMap(f).technologySkills, [{technologyId: 'react', skills: [local]}]);
    assert.deepEqual(protectedBytes(f), before);
    noDebris(f);
  }
});

test('dry runs and idempotent batches print the result and never create backups or locks', (t) => {
  const f = fixture(t), original = readFileSync(f.file), protectedBefore = protectedBytes(f);
  const operations = [['always', 'add', local], ['frontend-packages', 'add', 'react', 'react']];
  const preview = batch(f, operations, ['--dry-run', '--backup']);
  ok(preview);
  assert.deepEqual(JSON.parse(preview.stdout).alwaysRecommend, [local]);
  assert.deepEqual(readFileSync(f.file), original);
  assert.equal(existsSync(`${f.file}.bak`), false);
  noDebris(f);
  ok(batch(f, operations));
  const committed = readFileSync(f.file);
  const unchanged = batch(f, operations, ['--dry-run']);
  ok(unchanged);
  assert.equal(unchanged.stdout, committed.toString());
  ok(batch(f, operations));
  assert.deepEqual(readFileSync(f.file), committed);
  assert.deepEqual(protectedBytes(f), protectedBefore);
});

test('a failed operation or final reference/schema validation rolls back the whole batch', (t) => {
  const f = fixture(t), before = readFileSync(f.file);
  const failures = [
    [['always', 'add', local], ['always', 'remove', 'missing']],
    [['always', 'add', 'acme/registry/absent']],
    [['tech-skills', 'add', 'unknown', local]],
    [['tech', 'add', 'react', '--name', 'Builtin conflict']],
    [['combo', 'add', 'invalid', '--name', 'Invalid', '--requires', 'unknown']],
    [['combo-skills', 'add', 'unknown', local]],
    [['frontend-packages', 'add', '']],
    [['external', 'add', 'o/r/name', '--source', 'https://untrusted.invalid/o/r', '--skill', 'name']],
    [['tech', 'add', 'server', '--name', 'Server', '--detect-json', '{"mcpServers":[{"packages":["server"],"configFiles":["../.mcp.json"]}]}']],
    [['tech', 'add', 'regex', '--name', 'Regex', '--package-pattern', '/x/gg']],
  ];
  for (const operations of failures) {
    const result = batch(f, operations, ['--backup']);
    assert.notEqual(result.status, 0, JSON.stringify(operations));
    assert.deepEqual(readFileSync(f.file), before);
    assert.equal(existsSync(`${f.file}.bak`), false);
    noDebris(f);
  }
});

test('batches allow forward declarations and repair existing invalid references', (t) => {
  const f = fixture(t), m = initial();
  m.alwaysRecommend = ['stale-reference'];
  writeFileSync(f.file, JSON.stringify(m));
  ok(batch(f, [
    ['always', 'remove', 'stale-reference'],
    ['tech-skills', 'add', 'server', 'upstream/skills/review'],
    ['tech', 'add', 'server', '--name', 'Service MCP', '--detect-json', '{"mcpServers":[{"packages":["@example/service-mcp"],"configFiles":[".mcp.json"]}]}'],
    ['external', 'add', '--source', 'https://github.com/upstream/skills.git', '--skill', 'review'],
  ]));
  assert.equal(readMap(f).externalSkills[0].id, 'upstream/skills/review');
  assert.deepEqual(readMap(f).technologies[0].detect.mcpServers[0].packages, ['@example/service-mcp']);
  ok(run(f, ['validate']));
});

test('renames update every reference and guarded removal/pruning preserves unrelated mappings', (t) => {
  const f = fixture(t);
  ok(batch(f, [
    ['external', 'add', '--source', 'upstream/skills', '--skill', 'review', '--description', 'Original'],
    ['tech', 'add', 'custom', '--name', 'Custom', '--package', 'custom', '--skill', 'upstream/skills/review'],
    ['combo', 'add', 'combo', '--name', 'Combined', '--requires', 'custom,react', '--skill', 'upstream/skills/review'],
    ['tech-skills', 'add', 'custom', 'upstream/skills/review'],
    ['combo-skills', 'add', 'combo', 'upstream/skills/review'],
    ['always', 'add', 'upstream/skills/review', local],
    ['frontend-bonus', 'add', 'upstream/skills/review'],
    ['external', 'update', 'upstream/skills/review', '--new-id', 'upstream/skills/audit', '--skill', 'audit', '--clear-description'],
    ['tech', 'update', 'custom', '--new-id', 'renamed'],
    ['combo', 'update', 'combo', '--new-id', 'renamed-combo'],
  ]));
  const updated = readMap(f);
  assert.equal(JSON.stringify(updated).includes('upstream/skills/review'), false);
  assert.deepEqual(updated.combinations[0].requires, ['renamed', 'react']);
  assert.equal(updated.technologySkills[0].technologyId, 'renamed');
  assert.equal(updated.combinationSkills[0].combinationId, 'renamed-combo');
  assert.equal(updated.externalSkills[0].description, undefined);
  const before = readFileSync(f.file);
  assert.notEqual(run(f, ['external', 'remove', 'upstream/skills/audit']).status, 0);
  assert.notEqual(run(f, ['external', 'remove', 'upstream/skills/audit', '--keep-refs']).status, 0);
  assert.deepEqual(readFileSync(f.file), before);
  ok(run(f, ['external', 'remove', 'upstream/skills/audit', '--prune']));
  assert.deepEqual(readMap(f).alwaysRecommend, [local]);
  assert.deepEqual(readMap(f).technologySkills, []);
  ok(run(f, ['tech', 'remove', 'renamed', '--prune']));
  assert.deepEqual(readMap(f).combinations[0].requires, ['react']);
  noDebris(f);
});

test('detect updates, skill maintenance, flat lists and combination removal compose in a batch', (t) => {
  const f = fixture(t);
  ok(batch(f, [
    ['external', 'add', '--source', 'upstream/skills', '--skill', 'old'],
    ['tech', 'add', 'custom', '--name', 'Custom', '--package', 'old', '--config-file', 'custom.conf'],
    ['tech', 'update', 'custom', '--package', 'new', '--unset-detect', 'configFiles', '--skill', local],
    ['combo', 'add', 'combo', '--name', 'Combo', '--requires', 'custom,react'],
    ['combo-skills', 'set', 'combo', local],
    ['combo', 'update', 'combo', '--requires', 'custom,next', '--skill', local],
    ['combo', 'remove', 'combo', '--prune'],
    ['always', 'set', 'upstream/skills/old'],
    ['frontend-bonus', 'add', local],
    ['frontend-bonus', 'clear'],
    ['skill', 'rename', 'upstream/skills/old', 'upstream/skills/new'],
    ['skill', 'remove', 'upstream/skills/new'],
    ['tech-skills', 'set', 'custom', local],
    ['tech-skills', 'remove', 'custom', local],
    ['tech-skills', 'remove', 'custom'],
    ['frontend-extensions', 'set', '.jsx', '.tsx'],
    ['frontend-extensions', 'remove', '.jsx'],
  ]));
  const m = readMap(f);
  assert.deepEqual(m.technologies[0].detect, {packages: ['new']});
  assert.deepEqual(m.combinations, []);
  assert.deepEqual(m.combinationSkills, []);
  assert.deepEqual(m.webFrontendExtensions, ['.tsx']);
  assert.equal(m.externalSkills[0].id, 'upstream/skills/new');
  assert.deepEqual(m.alwaysRecommend, []);
});

test('formatting, permissions, annotations, custom fields and explicit backups survive editing', (t) => {
  const f = fixture(t), m = initial();
  // JSON fields named like JS prototype properties remain ordinary user data.
  Object.defineProperty(m, '__proto__', {value: {preserve: true}, enumerable: true});
  const raw = '\uFEFF' + JSON.stringify(m, null, '\t').replaceAll('\n', '\r\n');
  writeFileSync(f.file, raw);
  chmodSync(f.file, 0o640);
  ok(run(f, ['--backup', 'always', 'add', local]));
  const after = readFileSync(f.file, 'utf8');
  assert.ok(after.startsWith('\uFEFF{\r\n\t'));
  assert.equal(after.endsWith('\n'), false);
  assert.equal(after.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(statSync(f.file).mode & 0o777, 0o640);
  assert.equal(readFileSync(`${f.file}.bak`, 'utf8'), raw);
  assert.equal(readMap(f).$schema, m.$schema);
  assert.deepEqual(readMap(f).customMetadata, m.customMetadata);
  assert.deepEqual(readMap(f).__proto__, {preserve: true});
});

test('usage errors, unsafe batch forms and validation bypass attempts leave the map unchanged', (t) => {
  const f = fixture(t), before = readFileSync(f.file);
  for (const args of [
    ['--force', 'always', 'add', local], ['--schema', 'elsewhere', 'validate'],
    ['tech', 'add', 'x', 'ignored', '--name', 'X'], ['always', 'clear', 'ignored'],
    ['always', 'add', local, '--dry-run=perhaps'], ['tech', 'add', 'x', '--name'],
    ['external', 'remove', 'x', '--prune', '--keep-refs'], ['--surprise', 'x', 'validate'],
    ['--__proto__', 'x', 'validate'], ['registry', 'set', 'other/registry'],
  ]) {
    assert.equal(run(f, args).status, 2, JSON.stringify(args));
    assert.deepEqual(readFileSync(f.file), before);
    noDebris(f);
  }
  for (const ops of [
    ['always add x'], [[1]], [['batch', '-']], [['init', '--registry-id', 'o/r']],
    [['always', 'add', local, '--root', f.root]], [['validate']],
  ]) {
    assert.equal(batch(f, ops).status, 2, JSON.stringify(ops));
    assert.deepEqual(readFileSync(f.file), before);
    noDebris(f);
  }
});

test('unsafe map/manifest paths and identity mismatches fail without changing protected data', (t) => {
  for (const kind of ['map-symlink', 'map-hardlink', 'manifest-symlink', 'identity']) {
    const f = fixture(t), before = protectedBytes(f);
    if (kind.startsWith('map-')) {
      const target = path.join(f.temp, 'original.json');
      writeFileSync(target, readFileSync(f.file)); rmSync(f.file);
      if (kind === 'map-symlink') symlinkSync(target, f.file); else linkSync(target, f.file);
    } else if (kind === 'manifest-symlink') {
      const manifest = path.join(f.root, 'skills-manifest.json'), target = path.join(f.temp, 'manifest.json');
      writeFileSync(target, readFileSync(manifest)); rmSync(manifest); symlinkSync(target, manifest);
    } else writeFileSync(path.join(f.root, 'skills-manifest.json'), '{"registryId":"other/registry"}');
    const expected = kind === 'identity' ? protectedBytes(f) : before;
    const raw = readFileSync(f.file);
    assert.notEqual(run(f, ['always', 'add', local]).status, 0, kind);
    assert.deepEqual(readFileSync(f.file), raw);
    assert.deepEqual(protectedBytes(f), expected);
    noDebris(f);
  }
});

test('init uses public schema annotations, guards overwrites, and version changes cannot retain externals', (t) => {
  const f = fixture(t, {manifest: false});
  rmSync(f.file);
  ok(run(f, ['init', '--registry-id', 'acme/registry', '--schema-version', '1']));
  assert.equal(readMap(f).$schema, schemaURL('map'));
  assert.equal(readMap(f).schemaVersion, 1);
  assert.equal(readMap(f).externalSkills, undefined);
  assert.notEqual(run(f, ['init', '--registry-id', 'acme/registry']).status, 0);
  ok(batch(f, [['version', 'set', '2'], ['external', 'add', '--source', 'upstream/skills', '--skill', 'review']]));
  const before = readFileSync(f.file);
  assert.notEqual(run(f, ['version', 'set', '1']).status, 0);
  assert.deepEqual(readFileSync(f.file), before);
  ok(batch(f, [['external', 'remove', 'upstream/skills/review'], ['version', 'set', '1']]));
  ok(run(f, ['--force', 'init', '--registry-id', 'acme/registry', '--schema-ref', 'unchanged-custom-annotation']));
  assert.equal(readMap(f).$schema, 'unchanged-custom-annotation');
  const sameIdentity = readFileSync(f.file);
  assert.notEqual(run(f, ['--force', 'init', '--registry-id', 'other/registry']).status, 0);
  assert.deepEqual(readFileSync(f.file), sameIdentity);
});

test('relative --file paths work from a foreign CWD and cannot target generated documents', (t) => {
  const f = fixture(t), before = protectedBytes(f);
  const invoke = (file, args) => spawnSync(process.execPath, [script, '--file', path.relative(f.temp, file), '--schemas', path.relative(f.temp, f.schemaDir), ...args], {cwd: f.temp, encoding: 'utf8'});
  ok(invoke(f.file, ['always', 'add', local]));
  assert.deepEqual(readMap(f).alwaysRecommend, [local]);
  assert.equal(invoke(f.file, ['--root', f.root, 'show']).status, 2);
  assert.equal(invoke(path.join(f.root, 'skills-manifest.json'), ['--force', 'init', '--registry-id', 'acme/registry']).status, 2);
  assert.deepEqual(protectedBytes(f), before);
  noDebris(f);
});

test('a failed atomic replacement leaves map bytes intact and cleans temporary files and locks', (t) => {
  const f = fixture(t), before = readFileSync(f.file), protectedBefore = protectedBytes(f);
  const code = `import fs from 'node:fs'; const original = fs.renameSync; fs.renameSync = (source, target) => {
    if (target === ${JSON.stringify(f.file)}) throw Error('simulated rename failure');
    return original(source, target);
  };`;
  const result = run(f, ['always', 'add', local], {nodeArgs: ['--import', `data:text/javascript,${encodeURIComponent(code)}`]});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated rename failure/);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(protectedBytes(f), protectedBefore);
  noDebris(f);
});

test('live validation fetches only fixed URLs and fails closed on outages and schema vocabulary changes', (t) => {
  const f = fixture(t), before = readFileSync(f.file);
  const preload = (body) => ['--import', `data:text/javascript,${encodeURIComponent(body)}`];
  const mock = `const docs = ${JSON.stringify(schemas)}; globalThis.fetch = async (url) => {
    if (url === ${JSON.stringify(schemaURL('map'))}) return Response.json(docs.map);
    if (url === ${JSON.stringify(schemaURL('manifest'))}) return Response.json(docs.manifest);
    throw Error('Unexpected schema URL: ' + url);
  };`;
  ok(run(f, ['validate'], {fixtures: false, nodeArgs: preload(mock)}));
  const offline = run(f, ['always', 'add', local], {fixtures: false, nodeArgs: preload("globalThis.fetch = async () => { throw Error('simulated offline'); };")});
  assert.notEqual(offline.status, 0);
  assert.match(offline.stderr, /Cannot load Nosey schema.*simulated offline/);
  assert.deepEqual(readFileSync(f.file), before);
  writeFileSync(path.join(f.schemaDir, 'skills-map.schema.json'), JSON.stringify({...schemas.map, unreviewedAssertion: true}));
  assert.notEqual(run(f, ['always', 'add', local]).status, 0);
  assert.deepEqual(readFileSync(f.file), before);
  noDebris(f);
});

test('concurrent editors retain both changes and concurrent initialization has exactly one winner', async (t) => {
  const f = fixture(t, {manifest: false});
  const results = await Promise.all([
    asyncRun(f, ['frontend-packages', 'add', 'react']),
    asyncRun(f, ['frontend-packages', 'add', 'vue']),
  ]);
  results.forEach(ok);
  assert.deepEqual(readMap(f).frontendPackages.sort(), ['react', 'vue']);
  rmSync(f.file);
  const initResults = await Promise.all([
    asyncRun(f, ['init', '--registry-id', 'acme/registry']),
    asyncRun(f, ['init', '--registry-id', 'acme/registry']),
  ]);
  assert.deepEqual(initResults.map((result) => result.status).sort(), [0, 1]);
  assert.match(initResults.find((result) => result.status === 1).stderr, /already exists/);
  noDebris(f);
});

test('an old lock is never stolen; read-only discovery and dry-run do not touch it', (t) => {
  const f = fixture(t), before = readFileSync(f.file);
  const lock = `${f.file}.lock`, lockBytes = JSON.stringify({pid: process.pid, time: Date.now() - 120_000});
  writeFileSync(lock, lockBytes);
  ok(run(f, ['discover']));
  ok(run(f, ['--dry-run', 'always', 'add', local]));
  const result = run(f, ['always', 'add', local]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not acquire lock/);
  assert.equal(readFileSync(lock, 'utf8'), lockBytes);
  assert.deepEqual(readFileSync(f.file), before);
});

test('Node versions below 22 fail before commands can change files', (t) => {
  const f = fixture(t), before = readFileSync(f.file), protectedBefore = protectedBytes(f);
  const args = ['--root', f.root, '--schemas', f.schemaDir, 'always', 'add', local];
  const code = `Object.defineProperty(process.versions, 'node', {value: '20.0.0'}); const {main} = await import(${JSON.stringify(new URL('./skills-map.mjs', import.meta.url).href)}); await main(${JSON.stringify(args)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 22 or newer is required/);
  assert.equal(result.stdout, '');
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(protectedBytes(f), protectedBefore);
  noDebris(f);
});

test('newer Node majors can execute editing commands', (t) => {
  const f = fixture(t), protectedBefore = protectedBytes(f);
  const args = ['--root', f.root, '--schemas', f.schemaDir, 'always', 'add', local];
  const code = `Object.defineProperty(process.versions, 'node', {value: '24.0.0'}); const {main} = await import(${JSON.stringify(new URL('./skills-map.mjs', import.meta.url).href)}); await main(${JSON.stringify(args)});`;
  ok(spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8'}));
  assert.deepEqual(readMap(f).alwaysRecommend, [local]);
  assert.deepEqual(protectedBytes(f), protectedBefore);
  noDebris(f);
});
