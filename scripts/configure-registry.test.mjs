import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {configureRegistry, DOWNSTREAM_GUIDE_PATH, DOWNSTREAM_GUIDE_SHA256, MAINTAINER_GUIDE_SHA256, MAINTAINER_GUIDE_SENTINEL} from './configure-registry.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(source, 'test/fixtures/identity/v1');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const schemas = {
  manifest: {type: 'object'},
  map: {type: 'object', 'x-builtInTechnologies': [{id: 'react', name: 'React'}, {id: 'typescript', name: 'TypeScript'}], 'x-builtInCombinations': []},
};

async function tempRoot() { return mkdtemp(path.join(os.tmpdir(), 'nosey-configure-')); }
async function readCase(name) {
  const dir = path.join(fixtureRoot, name);
  const dest = await tempRoot();
  await cp(path.join(dir, 'input'), dest, {recursive: true});
  await mkdir(path.join(dest, '.agents/templates'), {recursive: true});
  await cp(path.join(fixtureRoot, 'downstream-guide.md'), path.join(dest, DOWNSTREAM_GUIDE_PATH));
  return {dir, dest};
}
async function bytes(root, files) {
  const entries = [];
  for (const file of files) {
    try { entries.push([file, await readFile(path.join(root, file))]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries.push([file, null]); }
  }
  return entries;
}
async function ensureClean(root) {
  const all = [];
  async function walk(dir, prefix = '') {
    for (const item of await readdir(dir, {withFileTypes: true})) {
      const rel = path.posix.join(prefix, item.name);
      if (item.isDirectory()) await walk(path.join(dir, item.name), rel);
      else all.push(rel);
    }
  }
  await walk(root);
  assert.ok(all.every((name) => !['.tmp', '.rollback', '.bak'].some((suffix) => name.endsWith(suffix))), `temporary files left behind: ${all}`);
}

test('guide policy digests match the checked-in source artifacts', async () => {
  const maintainer = await readFile(path.join(source, '../AGENTS.md'), 'utf8');
  const downstream = await readFile(path.resolve(source, '..', DOWNSTREAM_GUIDE_PATH), 'utf8');
  assert.equal(maintainer.startsWith(`${MAINTAINER_GUIDE_SENTINEL}\n`), true);
  assert.equal(digest(maintainer), MAINTAINER_GUIDE_SHA256);
  assert.equal(digest(downstream), DOWNSTREAM_GUIDE_SHA256);
});

test('shared configure-success golden output, guide replacement, and byte idempotency', async (t) => {
  const {dir, dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  const result = await configureRegistry(dest, 'acme/team-skills', {schemas});
  assert.deepEqual(new Set(result.changed), new Set(['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']));
  for (const name of ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']) {
    assert.deepEqual(await readFile(path.join(dest, name)), await readFile(path.join(dir, 'expected', name)), `${name} golden output`);
  }
  const after = await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']);
  const again = await configureRegistry(dest, 'acme/team-skills', {schemas});
  assert.deepEqual(again.changed, []);
  assert.deepEqual(await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']), after);
});

test('shared user-guide case preserves user bytes and matches golden outputs', async (t) => {
  const {dir, dest} = await readCase('guide-user-preserved');
  t.after(() => rm(dest, {recursive: true, force: true}));
  const result = await configureRegistry(dest, 'acme/team-skills', {schemas});
  assert.equal(result.changed.includes('AGENTS.md'), false);
  for (const name of ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']) {
    assert.deepEqual(await readFile(path.join(dest, name)), await readFile(path.join(dir, 'expected', name)), `${name} golden output`);
  }
});

test('all shared configure reject and rollback fixtures leave every input unchanged', async (t) => {
  const cases = ['guide-conflict', 'malformed-map', 'identity-mismatch', 'path-mismatch', 'undeclared-reference', 'readme-missing', 'readme-duplicate', 'readme-reversed', 'invalid-request', 'write-failure'];
  for (const name of cases) {
    const {dest} = await readCase(name);
    const metadata = JSON.parse(await readFile(path.join(dest, 'case.json'), 'utf8'));
    const files = metadata.inputs;
    const before = await bytes(dest, files);
    const options = {schemas};
    if (name === 'write-failure') options.fileOps = {beforeRename(_file, renamed) { if (renamed === 2) throw new Error('injected recoverable rename failure'); }};
    const requested = metadata.requestedIdentity ?? 'acme/team-skills';
    await assert.rejects(configureRegistry(dest, requested, options), undefined, name);
    assert.deepEqual(await bytes(dest, files), before, `${name} rejected/failed files remain byte-identical`);
    await ensureClean(dest);
    await rm(dest, {recursive: true, force: true});
  }
});

test('v1 nullable arrays are retained in the shared parse-only model', async () => {
  const map = JSON.parse(await readFile(path.join(fixtureRoot, 'v1-nullables/input/skills-map.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'v1-nullables/input/skills-manifest.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(path.join(fixtureRoot, 'v1-nullables/input/case.json'), 'utf8'));
  assert.equal(metadata.kind, 'parse');
  assert.equal(map.schemaVersion, 1);
  assert.equal(map.technologies, null);
  assert.equal(map.combinations, null);
  assert.equal(Object.hasOwn(map, 'externalSkills'), false);
  assert.equal(manifest.registryId, map.registryId);
});

test('reconstructed isolated v1 filesystem exercises nullable-array configuration', async (t) => {
  const {dest} = await readCase('v1-nullables');
  t.after(() => rm(dest, {recursive: true, force: true}));
  await cp(path.join(source, '../README.md'), path.join(dest, 'README.md'));
  const manifest = JSON.parse(await readFile(path.join(dest, 'skills-manifest.json'), 'utf8'));
  for (const skill of manifest.skills) {
    const filename = path.join(dest, skill.path);
    await mkdir(path.dirname(filename), {recursive: true});
    await writeFile(filename, `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`);
  }
  const result = await configureRegistry(dest, 'acme/team-skills', {schemas});
  assert.ok(result.changed.includes('skills-map.json'));
  const map = JSON.parse(await readFile(path.join(dest, 'skills-map.json'), 'utf8'));
  assert.equal(map.schemaVersion, 1);
  assert.equal(map.technologies, null);
  assert.equal(map.combinations, null);
  assert.equal(Object.hasOwn(map, 'externalSkills'), false);
  assert.equal(map.technologySkills[0].skills[0], 'acme/team-skills/nested/tooling/lint');
});

test('all six shared JSON annotation types survive configure unchanged', async () => {
  const values = JSON.parse(await readFile(path.join(fixtureRoot, 'schema-annotation-values.json'), 'utf8'));
  for (const {type, value} of values) {
    const {dest} = await readCase('configure-success');
    const mapPath = path.join(dest, 'skills-map.json');
    const manifestPath = path.join(dest, 'skills-manifest.json');
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    map.$schema = value;
    manifest.$schema = value;
    await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await configureRegistry(dest, 'acme/team-skills', {schemas});
    assert.deepEqual(JSON.parse(await readFile(mapPath, 'utf8')).$schema, value, `${type} map annotation`);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).$schema, value, `${type} manifest annotation`);
    await rm(dest, {recursive: true, force: true});
  }
});

test('rejects symlinked or hard-linked inputs before any write', async (t) => {
  for (const kind of ['symlink', 'hardlink']) {
    const {dest} = await readCase('configure-success');
    const target = path.join(dest, 'skills-map.json');
    const data = await readFile(target);
    await rm(target);
    const replacement = path.join(dest, 'map-original.json');
    await writeFile(replacement, data);
    if (kind === 'symlink') await symlink(replacement, target);
    else await link(replacement, target);
    await assert.rejects(configureRegistry(dest, 'acme/team-skills', {schemas}), /regular, unlinked file/);
    assert.deepEqual(await readFile(replacement), data);
    await rm(dest, {recursive: true, force: true});
  }
});

test('never reads registry.json, even when it is a dangling symlink', async (t) => {
  const {dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  await symlink(path.join(dest, 'missing-invalid-registry.json'), path.join(dest, 'registry.json'));
  await configureRegistry(dest, 'acme/team-skills', {schemas});
  assert.equal((await readFile(path.join(dest, 'skills-map.json'), 'utf8')).includes('acme/team-skills'), true);
});

test('staging write failure cleans staged files and leaves every original byte intact', async (t) => {
  const {dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  const metadata = JSON.parse(await readFile(path.join(dest, 'case.json'), 'utf8'));
  const before = await bytes(dest, metadata.inputs);
  let writes = 0;
  await assert.rejects(configureRegistry(dest, 'acme/team-skills', {
    schemas,
    fileOps: {async writeFile(filename, contents, options) {
      if (++writes === 2) throw new Error('injected staging write failure');
      return writeFile(filename, contents, options);
    }},
  }), /injected staging write failure/);
  assert.deepEqual(await bytes(dest, metadata.inputs), before);
  await ensureClean(dest);
});

test('rejects symlinked and hard-linked declared skill files before mutation', async (t) => {
  for (const kind of ['symlink', 'hardlink']) {
    const {dest} = await readCase('configure-success');
    const skill = path.join(dest, 'skills/nested/release/SKILL.md');
    const outside = path.join(dest, 'skill-original.md');
    const data = await readFile(skill);
    await rm(skill);
    await writeFile(outside, data);
    if (kind === 'symlink') await symlink(outside, skill);
    else await link(outside, skill);
    await assert.rejects(configureRegistry(dest, 'acme/team-skills', {schemas}), /symlink|unsafe file or directory|without links/i);
    assert.deepEqual(await readFile(outside), data);
    await rm(dest, {recursive: true, force: true});
  }
});
