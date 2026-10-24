import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {configureRegistry, DOWNSTREAM_GUIDE_PATH, DOWNSTREAM_GUIDE_SHA256, MAINTAINER_GUIDE_SHA256, MAINTAINER_GUIDE_SENTINEL} from './configure-registry.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
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
  const cases = ['guide-conflict', 'guide-bom', 'json-bom', 'malformed-map', 'identity-mismatch', 'path-mismatch', 'undeclared-reference', 'readme-missing', 'readme-duplicate', 'readme-reversed', 'invalid-request', 'write-failure'];
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

test('direct Node CLI accepts owner/repo with explicit schema fixtures', async (t) => {
  const {dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  const schemaDir = path.join(dest, 'schema-fixtures');
  await mkdir(schemaDir);
  await writeFile(path.join(schemaDir, 'skills-manifest.schema.json'), JSON.stringify({type: 'object'}));
  await writeFile(path.join(schemaDir, 'skills-map.schema.json'), JSON.stringify(schemas.map));
  const result = spawnSync(process.execPath, [
    path.join(source, 'configure-registry.mjs'), 'acme/cli-test', '--root', dest, '--schemas', schemaDir,
  ], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured registry acme\/cli-test/);
  assert.equal(JSON.parse(await readFile(path.join(dest, 'skills-map.json'), 'utf8')).registryId, 'acme/cli-test');
});

test('real Nosey schemas keep configure and both generators byte-consistent for large unknown data', async (t) => {
  const noseySchemas = path.resolve(source, '../../nosey/schemas/registry');
  try { await readFile(path.join(noseySchemas, 'skills-map.schema.json')); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('sibling Nosey checkout is unavailable'); throw error; }
  const {dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  const mapPath = path.join(dest, 'skills-map.json');
  const manifestPath = path.join(dest, 'skills-manifest.json');
  const readmePath = path.join(dest, 'README.md');
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const large = 'x'.repeat(1_100_000);
  map.$schema = {customAnnotation: large};
  manifest.$schema = {customAnnotation: large};
  map.customAnnotation = {payload: large, reviewed: true};
  manifest.customMetadata = {payload: large, reviewed: true};
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const authoredSuffix = `\n<!-- authored bytes -->\n${'y'.repeat(1_100_000)}\n`;
  await writeFile(readmePath, `${await readFile(readmePath, 'utf8')}${authoredSuffix}`);

  const schemas = {
    manifest: JSON.parse(await readFile(path.join(noseySchemas, 'skills-manifest.schema.json'), 'utf8')),
    map: JSON.parse(await readFile(path.join(noseySchemas, 'skills-map.schema.json'), 'utf8')),
  };
  await configureRegistry(dest, 'acme/team-skills', {schemas});
  const generated = await Promise.all([
    exec(process.execPath, [path.join(source, 'generate-manifest.mjs'), '--root', dest, '--check']),
    exec(process.execPath, [path.join(source, 'generate-readme.mjs'), '--root', dest, '--check']),
  ]);
  assert.match(generated[0].stdout, /Manifest is current/);
  assert.match(generated[1].stdout, /README skill catalog is current/);
  assert.deepEqual(JSON.parse(await readFile(mapPath, 'utf8')).customAnnotation, {payload: large, reviewed: true});
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).customMetadata, {payload: large, reviewed: true});
  assert.deepEqual(JSON.parse(await readFile(mapPath, 'utf8')).$schema, {customAnnotation: large});
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).$schema, {customAnnotation: large});
  assert.ok((await readFile(readmePath, 'utf8')).endsWith(authoredSuffix), 'authored README bytes outside markers survive');
  const before = await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']);
  assert.deepEqual((await configureRegistry(dest, 'acme/team-skills', {schemas})).changed, []);
  assert.deepEqual(await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']), before);
});

test('real Nosey schemas keep the ordinary shared golden configure output current', async (t) => {
  const noseySchemas = path.resolve(source, '../../nosey/schemas/registry');
  try { await readFile(path.join(noseySchemas, 'skills-map.schema.json')); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('sibling Nosey checkout is unavailable'); throw error; }
  const {dir, dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  const schemas = {
    manifest: JSON.parse(await readFile(path.join(noseySchemas, 'skills-manifest.schema.json'), 'utf8')),
    map: JSON.parse(await readFile(path.join(noseySchemas, 'skills-map.schema.json'), 'utf8')),
  };
  const expected = await Promise.all(['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']
    .map(name => readFile(path.join(dir, 'expected', name))));
  await configureRegistry(dest, 'acme/team-skills', {schemas});
  for (const [index, name] of ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md'].entries()) {
    assert.deepEqual(await readFile(path.join(dest, name)), expected[index], `${name} shared golden bytes`);
  }
  const results = await Promise.all([
    exec(process.execPath, [path.join(source, 'generate-manifest.mjs'), '--root', dest, '--check']),
    exec(process.execPath, [path.join(source, 'generate-readme.mjs'), '--root', dest, '--check']),
  ]);
  assert.match(results[0].stdout, /Manifest is current/);
  assert.match(results[1].stdout, /README skill catalog is current/);
  const before = await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']);
  assert.deepEqual((await configureRegistry(dest, 'acme/team-skills', {schemas})).changed, []);
  assert.deepEqual(await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']), before);
});

test('manual configure uses the shared local identity grammar', async (t) => {
  const accepted = [
    'acme.name/repo',
    'acme_name/repo',
    `${'a'.repeat(40)}/repo`,
    'octocat/hello-world',
    'acme/repo_name.v2-rc',
    `acme/${'r'.repeat(101)}`,
  ];
  const rejected = ['./repo', '../repo', 'acme./repo', 'acme/repo.', 'acme/team/repo', '/repo', 'acme/', ''];

  for (const id of accepted) {
    const {dest} = await readCase('configure-success');
    try {
      await configureRegistry(dest, id, {schemas});
      assert.equal(JSON.parse(await readFile(path.join(dest, 'skills-map.json'), 'utf8')).registryId, id);
      const manifest = JSON.parse(await readFile(path.join(dest, 'skills-manifest.json'), 'utf8'));
      assert.ok(manifest.skills.every((skill) => skill.id.startsWith(`${id}/`)));
    } finally {
      await rm(dest, {recursive: true, force: true});
    }
  }

  for (const id of rejected) {
    const {dest} = await readCase('configure-success');
    try {
      const before = await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']);
      await assert.rejects(configureRegistry(dest, id, {schemas}), /valid local owner\/repository identity/);
      assert.deepEqual(await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']), before);
    } finally {
      await rm(dest, {recursive: true, force: true});
    }
  }
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

test('failed rollback preserves and reports the original backup path', async (t) => {
  const {dest} = await readCase('configure-success');
  t.after(() => rm(dest, {recursive: true, force: true}));
  let injected = false;
  await assert.rejects(configureRegistry(dest, 'acme/team-skills', {
    schemas,
    fileOps: {
      beforeRename(_file, renamed) { if (renamed === 1) throw new Error('injected replacement failure'); },
      async restore(source, target) {
        if (!injected && source.endsWith('.bak')) { injected = true; throw new Error('injected restore failure'); }
        return rename(source, target);
      },
    },
  }), (error) => {
    assert.match(error.message, /rollback failed/);
    const backup = error.message.match(/original preserved at ([^; )]+)/)?.[1];
    assert.ok(backup, 'error includes recoverable backup path');
    assert.equal(path.dirname(backup), dest);
    return true;
  });
  assert.equal(injected, true);
});

test('fixed input and output files use the same 4 MiB limits as Nosey', async (t) => {
  for (const name of ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']) {
    const {dest} = await readCase('configure-success');
    const filename = path.join(dest, name);
    const before = await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']);
    await writeFile(filename, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    const oversized = await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']);
    await assert.rejects(configureRegistry(dest, 'acme/team-skills', {schemas}), /size limit|limit/i, name);
    assert.deepEqual(await bytes(dest, ['skills-map.json', 'skills-manifest.json', 'README.md', 'AGENTS.md']), oversized, `${name} oversized input remains untouched`);
    assert.notDeepEqual(oversized, before);
    await rm(dest, {recursive: true, force: true});
  }
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
