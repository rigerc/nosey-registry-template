import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  addStringListItems, addTechnologySkills, checkMapDocument, createMapDocument, isValidRegistryId,
  readManifestSkillIds, removeTechnologies, removeTechnologySkills, serializeMap, setRegistryId, writeMapFile,
} from './lib/skills-map.mjs';

const exec = promisify(execFile);
const node = process.env.NODE22_BIN ?? process.execPath;
const cli = fileURLToPath(new URL('./skills-map-cli.mjs', import.meta.url));

const REGISTRY = 'owner/demo';
const defaultMap = () => ({
  $schema: 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json',
  schemaVersion: 2, registryId: REGISTRY, alwaysRecommend: [`${REGISTRY}/one`], externalSkills: [],
  technologies: [], technologySkills: [], combinations: [], combinationSkills: [],
  frontendBonusSkills: [], frontendPackages: [], webFrontendExtensions: [],
});
const defaultManifest = () => ({schemaVersion: 1, registryId: REGISTRY, skills: [{id: `${REGISTRY}/one`, name: 'One', path: 'skills/one/SKILL.md'}]});
const fixtureSchemas = {
  manifest: {
    type: 'object', required: ['schemaVersion', 'registryId', 'skills'],
    properties: {
      schemaVersion: {const: 1}, registryId: {type: 'string'},
      skills: {type: 'array', items: {type: 'object', required: ['id', 'name', 'path'], properties: {id: {type: 'string'}, name: {type: 'string'}, path: {type: 'string'}}}},
    },
  },
  map: {
    type: 'object', required: ['schemaVersion', 'registryId'],
    properties: {
      schemaVersion: {enum: [1, 2]}, registryId: {type: 'string', minLength: 1},
      alwaysRecommend: {type: 'array', items: {type: 'string', minLength: 1}},
      externalSkills: {type: 'array', items: {type: 'object', required: ['id', 'name', 'source', 'skill']}},
      technologies: {type: 'array', items: {type: 'object', required: ['id', 'name', 'detect']}},
      technologySkills: {type: 'array', items: {type: 'object', required: ['technologyId', 'skills']}},
      combinations: {type: 'array', items: {type: 'object', required: ['id', 'name', 'requires']}},
      combinationSkills: {type: 'array', items: {type: 'object', required: ['combinationId', 'skills']}},
      frontendBonusSkills: {type: 'array', items: {type: 'string', minLength: 1}},
      frontendPackages: {type: 'array', items: {type: 'string', minLength: 1}},
      webFrontendExtensions: {type: 'array', items: {type: 'string', minLength: 1}},
    },
    'x-builtInTechnologies': [{id: 'react', name: 'React'}],
    'x-builtInCombinations': [{id: 'react-clerk', name: 'React + Clerk'}],
  },
};

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function makeRegistry(t, {map = defaultMap(), manifest = defaultManifest()} = {}) {
  const root = await tempDir(t, 'nosey-mapcli-');
  await mkdir(path.join(root, 'skills/one'), {recursive: true});
  await writeFile(path.join(root, 'skills/one/SKILL.md'), '---\nname: One\n---\n');
  await writeFile(path.join(root, 'skills-map.json'), serializeMap(map));
  await writeFile(path.join(root, 'skills-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return root;
}
async function makeSchemasDir(t) {
  const dir = await tempDir(t, 'nosey-mapcli-schemas-');
  await writeFile(path.join(dir, 'skills-manifest.schema.json'), JSON.stringify(fixtureSchemas.manifest));
  await writeFile(path.join(dir, 'skills-map.schema.json'), JSON.stringify(fixtureSchemas.map));
  return dir;
}
async function runCli(args, {cwd, input} = {}) {
  if (input !== undefined) return runCliWithInput(args, {cwd, input});
  try {
    const {stdout, stderr} = await exec(node, [cli, ...args], {cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}
// execFile's async `input` option never ends the child's stdin pipe, so the
// stdin-detect test drives the child directly and closes stdin explicitly.
function runCliWithInput(args, {cwd, input}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, ...args], {cwd, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')}));
    child.stdin.end(input);
  });
}
const codes = (issues) => issues.map((item) => item.code);

async function loadMap(root) { return JSON.parse(await readFile(path.join(root, 'skills-map.json'), 'utf8')); }

// --- library: parser-rule checks -------------------------------------------

test('checkMapDocument accepts a healthy version 2 map with local and external references', () => {
  const map = defaultMap();
  map.externalSkills = [{id: 'acme/upstream/one', name: 'Upstream', source: 'acme/upstream', skill: 'one'}];
  map.alwaysRecommend = [`${REGISTRY}/one`, 'acme/upstream/one'];
  map.technologies = [{id: 'local-tech', name: 'Local', detect: {packages: ['pkg']}, skills: [`${REGISTRY}/one`]}];
  map.technologySkills = [{technologyId: 'react', skills: ['acme/upstream/one']}];
  const issues = checkMapDocument(map, {localSkillIds: new Set([`${REGISTRY}/one`])});
  assert.deepEqual(issues.filter((item) => item.severity === 'error'), []);
});

test('checkMapDocument enforces schema version and normalization rules', () => {
  const v1 = checkMapDocument({schemaVersion: 1, registryId: REGISTRY});
  assert.deepEqual(v1, []);
  const withExternal = checkMapDocument({schemaVersion: 1, registryId: REGISTRY, externalSkills: []});
  assert.deepEqual(codes(withExternal), ['external-skills-requires-v2']);
  const badVersion = checkMapDocument({schemaVersion: 3, registryId: REGISTRY});
  assert.deepEqual(codes(badVersion), ['schema-version']);
  const nullStrict = checkMapDocument({schemaVersion: 2, registryId: REGISTRY, alwaysRecommend: null});
  assert.deepEqual(codes(nullStrict), ['string-list']);
  const nullNormalized = checkMapDocument({schemaVersion: 2, registryId: REGISTRY, technologies: null});
  assert.deepEqual(nullNormalized, []);
  const shape = checkMapDocument({schemaVersion: 2, registryId: 'not-a-slug'});
  assert.deepEqual(codes(shape), ['registry-id-shape']);
});

test('checkMapDocument reports duplicate and malformed records', () => {
  const map = defaultMap();
  map.technologies = [
    {id: 'dup', name: 'A', detect: {}},
    {id: 'dup', name: 'B', detect: {}},
    {id: 'bad', detect: {}},
  ];
  const issues = checkMapDocument(map);
  assert.ok(issues.some((item) => item.code === 'unique' && item.path === 'technologies/1/id' && item.severity === 'error'));
  assert.ok(issues.some((item) => item.code === 'text' && item.path === 'technologies/2/name' && item.severity === 'error'));
});

test('checkMapDocument validates external skill shape and unknown fields', () => {
  const map = defaultMap();
  map.externalSkills = [
    {id: 'a/b', name: 'Bad ID', source: 'a/b', skill: 'x', extra: true},
    {id: 'o/r/ok', name: 'Bad source', source: 'https://example.com/o/r', skill: 'x'},
    {id: 'o/r/ok2', name: 'Bad skill', source: 'o/r', skill: '../escape'},
  ];
  const issues = checkMapDocument(map);
  assert.ok(issues.some((item) => item.code === 'pattern' && item.path === 'externalSkills/0/id'));
  assert.ok(issues.some((item) => item.code === 'external-skill-unknown-field' && item.path === 'externalSkills/0/extra'));
  assert.ok(issues.some((item) => item.code === 'pattern' && item.path === 'externalSkills/1/source'));
  assert.ok(issues.some((item) => item.code === 'pattern' && item.path === 'externalSkills/2/skill'));
});

test('checkMapDocument enforces regex, detection, and MCP parser rules', () => {
  const map = defaultMap();
  map.technologies = [
    {id: 't1', name: 'Stateful', detect: {packagePatterns: [{source: 'x', flags: 'gg'}]}},
    {id: 't2', name: 'Bad flags', detect: {packagePatterns: [{source: 'x', flags: 'q'}]}},
    {id: 't3', name: 'Too long', detect: {packagePatterns: [{source: 'x'.repeat(513)}]}},
    {id: 't4', name: 'Unknown field', detect: {extra: true}},
    {id: 't5', name: 'Bad MCP path', detect: {mcpServers: [{configFiles: ['../.mcp.json'], packages: ['x']}]}},
    {id: 't6', name: 'No identity', detect: {mcpServers: [{configFiles: ['.mcp.json']}]}},
  ];
  const issues = checkMapDocument(map);
  assert.ok(issues.some((item) => item.code === 'regex' && item.path === 'technologies/0/detect/packagePatterns/0' && /stateful/.test(item.message)));
  assert.ok(issues.some((item) => item.code === 'regex' && /unsupported regex flags/.test(item.message)));
  assert.ok(issues.some((item) => item.code === 'regex' && /512/.test(item.message)));
  assert.ok(issues.some((item) => item.code === 'detect-unknown-field' && item.path === 'technologies/3/detect/extra'));
  assert.ok(issues.some((item) => item.code === 'mcp-config-file' && item.path === 'technologies/4/detect/mcpServers/0/configFiles'));
  assert.ok(issues.some((item) => item.code === 'mcp-matcher-identity' && item.path === 'technologies/5/detect/mcpServers/0'));
});

test('checkMapDocument turns unknown references into errors with inventories and warnings without', () => {
  const map = defaultMap();
  map.combinations = [{id: 'combo', name: 'Combo', requires: ['raect']}];
  map.technologySkills = [{technologyId: 'reacct', skills: [`${REGISTRY}/one`]}];
  const withBuiltins = checkMapDocument(map, {builtinTechnologies: new Set(['react']), builtinCombinations: new Set(['react-clerk'])});
  assert.ok(withBuiltins.some((item) => item.code === 'unknown-technology' && item.severity === 'error'));
  assert.ok(withBuiltins.some((item) => item.code === 'unknown-reference' && item.severity === 'error'));
  const offline = checkMapDocument(map);
  assert.ok(offline.some((item) => item.code === 'unknown-technology-unverified' && item.severity === 'warning'));
  assert.ok(offline.some((item) => item.code === 'unknown-reference-unverified' && item.severity === 'warning'));
  const conflict = checkMapDocument({...map, technologies: [{id: 'react', name: 'React clone', detect: {}}]}, {builtinTechnologies: new Set(['react'])});
  assert.ok(conflict.some((item) => item.code === 'builtin-conflict'));
});

test('checkMapDocument verifies skill references against the manifest when available', () => {
  const map = defaultMap();
  map.alwaysRecommend = [`${REGISTRY}/one`, 'ghost/registry/two'];
  const withManifest = checkMapDocument(map, {localSkillIds: new Set([`${REGISTRY}/one`])});
  assert.ok(withManifest.some((item) => item.code === 'undeclared-skill' && item.severity === 'error' && /ghost\/registry\/two/.test(item.message)));
  const withoutManifest = checkMapDocument(map);
  assert.ok(withoutManifest.some((item) => item.code === 'undeclared-skill-unverified' && item.severity === 'warning'));
});

// --- library: mutations -----------------------------------------------------

test('list mutations are idempotent and preserve key order', () => {
  const map = {schemaVersion: 2, registryId: REGISTRY, alwaysRecommend: [`${REGISTRY}/one`]};
  const first = addStringListItems(map, 'frontendPackages', ['vite', 'vite'], 'frontend-package');
  assert.equal(first.changed, true);
  assert.deepEqual(map.frontendPackages, ['vite']);
  assert.deepEqual(first.ops, [{action: 'add', path: 'frontendPackages', value: 'vite'}]);
  assert.deepEqual(first.notices, ['frontend-package already present: vite']);
  const second = addStringListItems(map, 'frontendPackages', ['vite'], 'frontend-package');
  assert.equal(second.changed, false);
  const serialized = serializeMap(map);
  assert.ok(serialized.indexOf('"registryId"') < serialized.indexOf('"frontendPackages"'));
});

test('removing a declaration cascades its association recommendations', () => {
  const map = defaultMap();
  map.technologies = [{id: 'local-tech', name: 'Local', detect: {}}];
  map.technologySkills = [{technologyId: 'local-tech', skills: [`${REGISTRY}/one`]}];
  const result = removeTechnologies(map, ['local-tech', 'missing-tech']);
  assert.equal(result.changed, true);
  assert.deepEqual(map.technologies, []);
  assert.deepEqual(map.technologySkills, []);
  assert.ok(result.notices.some((notice) => /removed technologySkills/.test(notice)));
  assert.ok(result.notices.some((notice) => /not declared: missing-tech/.test(notice)));
});

test('association mutations append, deduplicate, and drop empty entries', () => {
  const map = defaultMap();
  addTechnologySkills(map, 'react', [`${REGISTRY}/one`]);
  addTechnologySkills(map, 'react', [`${REGISTRY}/one`, `${REGISTRY}/one`]);
  assert.deepEqual(map.technologySkills, [{technologyId: 'react', skills: [`${REGISTRY}/one`]}]);
  removeTechnologySkills(map, 'react', [`${REGISTRY}/one`]);
  assert.deepEqual(map.technologySkills, []);
});

test('setRegistryId remaps local references and leaves external IDs untouched', () => {
  const map = defaultMap();
  map.externalSkills = [{id: 'acme/upstream/one', name: 'Upstream', source: 'acme/upstream', skill: 'one'}];
  map.alwaysRecommend = [`${REGISTRY}/one`, 'acme/upstream/one'];
  map.technologies = [{id: 'local-tech', name: 'Local', detect: {}, skills: [`${REGISTRY}/one`]}];
  const result = setRegistryId(map, 'newowner/newrepo');
  assert.equal(result.changed, true);
  assert.equal(map.registryId, 'newowner/newrepo');
  assert.deepEqual(map.alwaysRecommend, ['newowner/newrepo/one', 'acme/upstream/one']);
  assert.deepEqual(map.technologies[0].skills, ['newowner/newrepo/one']);
  assert.deepEqual(map.externalSkills[0].id, 'acme/upstream/one');
  assert.deepEqual(setRegistryId(map, 'newowner/newrepo').changed, false);
});

test('createMapDocument emits the canonical empty map', () => {
  const doc = createMapDocument('acme/registry');
  assert.equal(doc.$schema, 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json');
  assert.equal(doc.schemaVersion, 2);
  assert.deepEqual(Object.keys(doc), ['$schema', 'schemaVersion', 'registryId', 'alwaysRecommend', 'externalSkills', 'technologies', 'technologySkills', 'combinations', 'combinationSkills', 'frontendBonusSkills', 'frontendPackages', 'webFrontendExtensions']);
  assert.ok(Object.values(doc).every((value) => value === 2 || value === 'acme/registry' || Array.isArray(value) && value.length === 0 || typeof value === 'string' && value.startsWith('https://')));
  assert.equal(isValidRegistryId('acme/registry'), true);
  assert.equal(isValidRegistryId('acme'), false);
});

// --- library: file I/O ------------------------------------------------------

test('writeMapFile writes atomically and rejects unsafe targets', async (t) => {
  const root = await tempDir(t, 'nosey-mapio-');
  await writeMapFile(root, createMapDocument('acme/registry'));
  const written = await readFile(path.join(root, 'skills-map.json'), 'utf8');
  assert.ok(written.endsWith('\n') && written.includes('"registryId": "acme/registry"'));
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);

  const linkRoot = await tempDir(t, 'nosey-mapio-link-');
  await writeFile(path.join(linkRoot, 'target.json'), '{}');
  await symlink(path.join(linkRoot, 'target.json'), path.join(linkRoot, 'skills-map.json'));
  await assert.rejects(writeMapFile(linkRoot, createMapDocument('acme/registry')), /symlink/);

  const hardRoot = await tempDir(t, 'nosey-mapio-hard-');
  await writeFile(path.join(hardRoot, 'skills-map.json'), '{}');
  await link(path.join(hardRoot, 'skills-map.json'), path.join(hardRoot, 'other.json'));
  await assert.rejects(writeMapFile(hardRoot, createMapDocument('acme/registry')), /hard-linked/);
});

test('readManifestSkillIds returns IDs when present and a warning when absent', async (t) => {
  const root = await tempDir(t, 'nosey-manifest-ids-');
  const missing = await readManifestSkillIds(root);
  assert.equal(missing.ids, null);
  assert.match(missing.warning, /skills-manifest\.json not found/);
  await writeFile(path.join(root, 'skills-manifest.json'), JSON.stringify(defaultManifest()));
  const present = await readManifestSkillIds(root);
  assert.deepEqual([...present.ids], [`${REGISTRY}/one`]);
  assert.equal(present.warning, undefined);
  await writeFile(path.join(root, 'skills-manifest.json'), '{broken');
  const broken = await readManifestSkillIds(root);
  assert.equal(broken.ids, null);
  assert.match(broken.warning, /Invalid JSON/);
});

// --- CLI: create ------------------------------------------------------------

test('create writes a canonical map, refuses overwrite, and requires a registry ID', async (t) => {
  const root = await tempDir(t, 'nosey-create-');
  const created = await runCli(['create', '--registry-id', 'acme/registry', '--root', root, '--json'], {cwd: root});
  assert.equal(created.code, 0);
  const doc = await loadMap(root);
  assert.equal(doc.schemaVersion, 2);
  assert.deepEqual(Object.keys(doc).slice(0, 3), ['$schema', 'schemaVersion', 'registryId']);

  const refused = await runCli(['create', '--registry-id', 'acme/registry', '--root', root, '--json'], {cwd: root});
  assert.equal(refused.code, 2);
  assert.match(JSON.parse(refused.stdout).issues[0].message, /already exists/);

  const forced = await runCli(['create', '--registry-id', 'acme/other', '--force', '--root', root, '--json'], {cwd: root});
  assert.equal(forced.code, 0);
  assert.equal((await loadMap(root)).registryId, 'acme/other');

  const bare = await mkdtemp(path.join(os.tmpdir(), 'nosey-create-bare-'));
  t.after(() => rm(bare, {recursive: true, force: true}));
  const noId = await runCli(['create', '--root', bare, '--json'], {cwd: bare});
  assert.equal(noId.code, 2);
  assert.match(JSON.parse(noId.stdout).issues[0].message, /--registry-id/);

  const badId = await runCli(['create', '--registry-id', 'no-slash', '--root', bare, '--json'], {cwd: bare});
  assert.equal(badId.code, 2);
});

// --- CLI: add / remove ------------------------------------------------------

test('add manages every section idempotently with structured JSON output', async (t) => {
  const root = await makeRegistry(t);
  const external = await runCli(['add', 'external', 'acme/upstream/one', '--name', 'Upstream', '--source', 'acme/upstream', '--skill', 'one', '--root', root, '--json'], {cwd: root});
  assert.equal(external.code, 0);
  assert.equal(JSON.parse(external.stdout).changed, true);

  const again = await runCli(['add', 'external', 'acme/upstream/one', '--name', 'Upstream', '--source', 'acme/upstream', '--skill', 'one', '--root', root, '--json'], {cwd: root});
  assert.equal(again.code, 0);
  const againDoc = JSON.parse(again.stdout);
  assert.equal(againDoc.changed, false);
  assert.match(againDoc.notices[0], /already declared/);

  const recommend = await runCli(['add', 'always-recommend', 'acme/upstream/one', '--root', root, '--json'], {cwd: root});
  assert.equal(recommend.code, 0);
  assert.deepEqual((await loadMap(root)).alwaysRecommend, [`${REGISTRY}/one`, 'acme/upstream/one']);

  for (const [target, alias, section, value] of [
    ['frontend-bonus-skill', 'frontend-bonus-skills', 'frontendBonusSkills', `${REGISTRY}/one`],
    ['frontend-package', 'frontend-packages', 'frontendPackages', 'vite'],
    ['frontend-extension', 'frontend-extensions', 'webFrontendExtensions', 'jsx'],
  ]) {
    const result = await runCli(['add', target, value, '--root', root, '--json'], {cwd: root});
    assert.equal(result.code, 0, target);
    assert.deepEqual((await loadMap(root))[section], [value]);
    const shown = await runCli(['show', alias, '--root', root, '--json'], {cwd: root});
    assert.deepEqual(JSON.parse(shown.stdout).value, [value]);
  }

  const removed = await runCli(['remove', 'frontend-package', 'vite', '--root', root, '--json'], {cwd: root});
  assert.equal(removed.code, 0);
  assert.deepEqual((await loadMap(root)).frontendPackages, []);
});

test('add validates before writing and blocks on map errors, not on stale integration state', async (t) => {
  const root = await makeRegistry(t);

  // Undeclared references are integration issues: warnings at edit time,
  // errors from validate. The edit is written and validate fails closed.
  const ghost = await runCli(['add', 'always-recommend', 'ghost/registry/two', '--root', root, '--json'], {cwd: root});
  assert.equal(ghost.code, 0);
  const ghostDoc = JSON.parse(ghost.stdout);
  assert.ok(ghostDoc.warnings.some((item) => item.code === 'undeclared-skill' && item.severity === 'warning'));
  assert.ok((await loadMap(root)).alwaysRecommend.includes('ghost/registry/two'));
  const schemas = await makeSchemasDir(t);
  const checked = await runCli(['validate', '--root', root, '--schemas', schemas, '--json'], {cwd: root});
  assert.equal(checked.code, 1);
  assert.ok(JSON.parse(checked.stdout).issues.some((item) => item.code === 'undeclared-skill' && item.severity === 'error'));

  // Map-level parser errors block the write entirely.
  const before = await readFile(path.join(root, 'skills-map.json'), 'utf8');
  const badExternal = await runCli(['add', 'external', 'bad/id', '--name', 'X', '--source', 'acme/up', '--skill', 'one', '--root', root, '--json'], {cwd: root});
  assert.equal(badExternal.code, 1);
  assert.ok(JSON.parse(badExternal.stdout).issues.some((item) => item.code === 'pattern'));
  assert.equal(await readFile(path.join(root, 'skills-map.json'), 'utf8'), before);

  const missingFlag = await runCli(['add', 'external', 'acme/up/x', '--root', root, '--json'], {cwd: root});
  assert.equal(missingFlag.code, 2);

  const v1Root = await makeRegistry(t, {map: {schemaVersion: 1, registryId: REGISTRY, alwaysRecommend: [`${REGISTRY}/one`]}});
  const v1 = await runCli(['add', 'external', 'acme/up/x', '--name', 'X', '--source', 'acme/up', '--skill', 'x', '--root', v1Root, '--json'], {cwd: v1Root});
  assert.equal(v1.code, 1);
  assert.ok(JSON.parse(v1.stdout).issues.some((item) => item.code === 'external-skills-requires-v2'));
});

test('add technology reads detect from inline JSON, stdin, and a file', async (t) => {
  const root = await makeRegistry(t);
  const inline = await runCli(['add', 'technology', 'local-tech', '--name', 'Local', '--detect', '{"packages":["pkg"]}', '--skill', `${REGISTRY}/one`, '--root', root, '--json'], {cwd: root});
  assert.equal(inline.code, 0);
  assert.deepEqual((await loadMap(root)).technologies, [{id: 'local-tech', name: 'Local', detect: {packages: ['pkg']}, skills: [`${REGISTRY}/one`]}]);

  const stdinFile = path.join(root, 'detect.json');
  await writeFile(stdinFile, '{"configFiles":["vite.config.ts"]}');
  const fromFile = await runCli(['add', 'technology', 'file-tech', '--name', 'File', '--detect', `@${stdinFile}`, '--root', root, '--json'], {cwd: root});
  assert.equal(fromFile.code, 0);
  assert.deepEqual((await loadMap(root)).technologies[1].detect, {configFiles: ['vite.config.ts']});

  const fromStdin = await runCli(['add', 'technology', 'stdin-tech', '--name', 'Stdin', '--detect', '-', '--root', root, '--json'], {cwd: root, input: '{"gems":["rake"]}'});
  assert.equal(fromStdin.code, 0);
  assert.deepEqual((await loadMap(root)).technologies[2].detect, {gems: ['rake']});

  const badJson = await runCli(['add', 'technology', 'bad-tech', '--name', 'Bad', '--detect', 'not json', '--root', root, '--json'], {cwd: root});
  assert.equal(badJson.code, 2);
  const badShape = await runCli(['add', 'technology', 'bad-shape', '--name', 'Bad', '--detect', '{"extra":true}', '--root', root, '--json'], {cwd: root});
  assert.equal(badShape.code, 1);
  assert.ok(JSON.parse(badShape.stdout).issues.some((item) => item.code === 'detect-unknown-field'));
});

test('technology-skills and combination mutations keep the map consistent', async (t) => {
  const root = await makeRegistry(t);
  const add = await runCli(['add', 'technology-skills', 'react', '--skill', `${REGISTRY}/one`, '--root', root, '--json'], {cwd: root});
  assert.equal(add.code, 0);
  assert.deepEqual((await loadMap(root)).technologySkills, [{technologyId: 'react', skills: [`${REGISTRY}/one`]}]);

  const combo = await runCli(['add', 'combination', 'local-combo', '--name', 'Local combo', '--requires', 'react,unknown-tech', '--skill', `${REGISTRY}/one`, '--root', root, '--json'], {cwd: root});
  assert.equal(combo.code, 0);
  assert.deepEqual((await loadMap(root)).combinations, [{id: 'local-combo', name: 'Local combo', requires: ['react', 'unknown-tech'], skills: [`${REGISTRY}/one`]}]);

  // unknown-tech is not declared locally; offline checks downgrade to a warning.
  assert.equal(JSON.parse(combo.stdout).ok, true);

  const comboSkills = await runCli(['add', 'combination-skills', 'local-combo', '--skill', `${REGISTRY}/one`, '--root', root, '--json'], {cwd: root});
  assert.equal(comboSkills.code, 0);
  assert.deepEqual((await loadMap(root)).combinationSkills, [{combinationId: 'local-combo', skills: [`${REGISTRY}/one`]}]);

  const cascade = await runCli(['remove', 'combination', 'local-combo', '--root', root, '--json'], {cwd: root});
  assert.equal(cascade.code, 0);
  const after = await loadMap(root);
  assert.deepEqual(after.combinations, []);
  assert.deepEqual(after.combinationSkills, []);

  const partial = await runCli(['remove', 'technology-skills', 'react', '--skill', `${REGISTRY}/one`, '--root', root, '--json'], {cwd: root});
  assert.equal(partial.code, 0);
  assert.deepEqual((await loadMap(root)).technologySkills, []);
});

test('set registry-id remaps references and surfaces the manifest mismatch to validate', async (t) => {
  const root = await makeRegistry(t);
  const remap = await runCli(['set', 'registry-id', 'newowner/newrepo', '--root', root, '--json'], {cwd: root});
  assert.equal(remap.code, 0);
  assert.equal(JSON.parse(remap.stdout).changed, true);
  const after = await loadMap(root);
  assert.equal(after.registryId, 'newowner/newrepo');
  assert.deepEqual(after.alwaysRecommend, ['newowner/newrepo/one']);

  const schemas = await makeSchemasDir(t);
  const check = await runCli(['validate', '--root', root, '--schemas', schemas, '--json'], {cwd: root});
  assert.equal(check.code, 1);
  assert.ok(JSON.parse(check.stdout).issues.some((item) => item.code === 'undeclared-skill' && /newowner\/newrepo\/one/.test(item.message)));
});

// --- CLI: dry-run and show --------------------------------------------------

test('dry-run reports ops and content without writing', async (t) => {
  const root = await makeRegistry(t);
  const before = await readFile(path.join(root, 'skills-map.json'), 'utf8');
  const dry = await runCli(['add', 'frontend-extension', 'jsx', '--dry-run', '--root', root, '--json'], {cwd: root});
  assert.equal(dry.code, 0);
  const dryDoc = JSON.parse(dry.stdout);
  assert.equal(dryDoc.dryRun, true);
  assert.deepEqual(dryDoc.ops, [{action: 'add', path: 'webFrontendExtensions', value: 'jsx'}]);
  assert.match(dryDoc.content, /jsx/);
  assert.equal(await readFile(path.join(root, 'skills-map.json'), 'utf8'), before);
});

test('show prints the raw map and normalized sections', async (t) => {
  const root = await makeRegistry(t);
  const whole = await runCli(['show', '--root', root, '--json'], {cwd: root});
  assert.equal(whole.code, 0);
  assert.deepEqual(JSON.parse(whole.stdout).value, await loadMap(root));

  const empty = await runCli(['show', 'frontend-bonus-skills', '--root', root, '--json'], {cwd: root});
  assert.deepEqual(JSON.parse(empty.stdout).value, []);

  const field = await runCli(['show', 'alwaysRecommend', '--root', root, '--json'], {cwd: root});
  assert.equal(field.code, 0);
  assert.deepEqual(JSON.parse(field.stdout).value, [`${REGISTRY}/one`]);
  const alias = await runCli(['show', 'always-recommend', '--root', root, '--json'], {cwd: root});
  assert.deepEqual(JSON.parse(alias.stdout).value, [`${REGISTRY}/one`]);

  const unknown = await runCli(['show', 'bogus', '--root', root, '--json'], {cwd: root});
  assert.equal(unknown.code, 2);
});

test('discover previews local skill IDs without writing the manifest', async (t) => {
  const root = await makeRegistry(t);
  const manifestPath = path.join(root, 'skills-manifest.json');
  const before = await readFile(manifestPath, 'utf8');
  const result = await runCli(['discover', '--root', root, '--json'], {cwd: root});
  assert.equal(result.code, 0);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.registryId, REGISTRY);
  assert.deepEqual(doc.skills.map((skill) => [skill.id, skill.path]), [[`${REGISTRY}/one`, 'skills/one/SKILL.md']]);
  assert.equal(await readFile(manifestPath, 'utf8'), before);

  const human = await runCli(['discover', '--root', root], {cwd: root});
  assert.equal(human.code, 0);
  assert.match(human.stdout, new RegExp(`${REGISTRY}/one\\tskills/one/SKILL\\.md`));
});

// --- CLI: batch -------------------------------------------------------------

test('batch applies operations as one validated write and rejects unsafe input', async (t) => {
  const root = await makeRegistry(t);
  const dir = await tempDir(t, 'nosey-batch-');
  const ops = path.join(dir, 'ops.json');
  await writeFile(ops, JSON.stringify([
    ['add', 'technology-skills', 'react', '--skill', `${REGISTRY}/one`],
    ['add', 'frontend-package', 'vite'],
  ]));
  const applied = await runCli(['batch', ops, '--root', root, '--json'], {cwd: root});
  assert.equal(applied.code, 0);
  const doc = JSON.parse(applied.stdout);
  assert.equal(doc.command, 'batch');
  assert.equal(doc.changed, true);
  const map = await loadMap(root);
  assert.deepEqual(map.technologySkills, [{technologyId: 'react', skills: [`${REGISTRY}/one`]}]);
  assert.deepEqual(map.frontendPackages, ['vite']);

  const before = await readFile(path.join(root, 'skills-map.json'), 'utf8');
  await writeFile(ops, JSON.stringify([['add', 'frontend-package', 'rollup'], ['add', 'bogus-target', 'x']]));
  const failed = await runCli(['batch', ops, '--root', root, '--json'], {cwd: root});
  assert.equal(failed.code, 2);
  assert.match(JSON.parse(failed.stdout).issues[0].message, /batch\[1\]/);
  assert.equal(await readFile(path.join(root, 'skills-map.json'), 'utf8'), before);

  await writeFile(ops, JSON.stringify([['add', 'frontend-package', 'rollup', '--json']]));
  const rejected = await runCli(['batch', ops, '--root', root, '--json'], {cwd: root});
  assert.equal(rejected.code, 2);
  assert.match(JSON.parse(rejected.stdout).issues[0].message, /global option --json/);

  await writeFile(ops, JSON.stringify([]));
  const empty = await runCli(['batch', ops, '--root', root, '--json'], {cwd: root});
  assert.equal(empty.code, 2);
});

// --- CLI: interactive -------------------------------------------------------

test('interactive mode edits sections from prompted input', async (t) => {
  const root = await makeRegistry(t);
  const added = await runCli(['--interactive', '--root', root], {cwd: root, input: `1\na\n${REGISTRY}/two\nq\n`});
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /Updated skills-map\.json \(1 operation\(s\)\)/);
  assert.deepEqual((await loadMap(root)).alwaysRecommend, [`${REGISTRY}/one`, `${REGISTRY}/two`]);

  const guarded = await runCli(['-i', '--json', '--root', root], {cwd: root});
  assert.equal(guarded.code, 2);
  assert.match(JSON.parse(guarded.stdout).issues[0].message, /cannot be combined with --json/);
  const dryGuarded = await runCli(['-i', '--dry-run', '--root', root], {cwd: root});
  assert.equal(dryGuarded.code, 2);
});

test('interactive mode refuses invalid edits without writing', async (t) => {
  const root = await makeRegistry(t);
  const before = await readFile(path.join(root, 'skills-map.json'), 'utf8');
  const result = await runCli(['--interactive', '--root', root], {
    cwd: root,
    input: '2\na\nbad\nBad\nnope\nskill\nq\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /was not changed/);
  assert.equal(await readFile(path.join(root, 'skills-map.json'), 'utf8'), before);
});

// --- CLI: validate ----------------------------------------------------------

test('validate passes a healthy registry and reports structured issues otherwise', async (t) => {
  const root = await makeRegistry(t);
  const schemas = await makeSchemasDir(t);
  const healthy = await runCli(['validate', '--root', root, '--schemas', schemas, '--json'], {cwd: root});
  assert.equal(healthy.code, 0);
  const healthyDoc = JSON.parse(healthy.stdout);
  assert.equal(healthyDoc.ok, true);
  assert.deepEqual(healthyDoc.issues, []);

  const broken = await makeRegistry(t, {map: {...defaultMap(), alwaysRecommend: [`${REGISTRY}/one`, 'ghost/registry/two']}});
  const ghost = await runCli(['validate', '--root', broken, '--schemas', schemas, '--json'], {cwd: broken});
  assert.equal(ghost.code, 1);
  const ghostDoc = JSON.parse(ghost.stdout);
  assert.equal(ghostDoc.ok, false);
  assert.ok(ghostDoc.issues.some((item) => item.code === 'undeclared-skill' && item.severity === 'error'));
  assert.equal(ghostDoc.summary.errors > 0, true);

  const structural = await makeRegistry(t, {map: {...defaultMap(), schemaVersion: 3}});
  const invalid = await runCli(['validate', '--root', structural, '--schemas', schemas, '--json'], {cwd: structural});
  assert.equal(invalid.code, 1);
  assert.ok(JSON.parse(invalid.stdout).issues.some((item) => item.code === 'schema'));
});

test('validate treats a missing manifest as a warning and an unreadable one as an error', async (t) => {
  const schemas = await makeSchemasDir(t);
  const missing = await makeRegistry(t);
  await rm(path.join(missing, 'skills-manifest.json'));
  const absent = await runCli(['validate', '--root', missing, '--schemas', schemas, '--json'], {cwd: missing});
  assert.equal(absent.code, 0);
  const absentDoc = JSON.parse(absent.stdout);
  assert.equal(absentDoc.ok, true);
  assert.deepEqual(absentDoc.issues.map((item) => item.code), ['manifest-missing', 'undeclared-skill-unverified']);
  assert.ok(absentDoc.issues.every((item) => item.severity === 'warning'));

  const unreadable = await makeRegistry(t);
  await writeFile(path.join(unreadable, 'skills-manifest.json'), '{broken');
  const broken = await runCli(['validate', '--root', unreadable, '--schemas', schemas, '--json'], {cwd: unreadable});
  assert.equal(broken.code, 1);
  const brokenDoc = JSON.parse(broken.stdout);
  assert.equal(brokenDoc.ok, false);
  const unreadableIssue = brokenDoc.issues.find((item) => item.code === 'manifest-unreadable');
  assert.equal(unreadableIssue?.severity, 'error');
  assert.equal(brokenDoc.issues.some((item) => item.code === 'manifest-missing'), false);
});

test('validate exits 3 when the schema source fails', async (t) => {
  const root = await makeRegistry(t);
  const empty = await tempDir(t, 'nosey-empty-schemas-');
  const result = await runCli(['validate', '--root', root, '--schemas', empty, '--json'], {cwd: root});
  assert.equal(result.code, 3);
  assert.equal(JSON.parse(result.stdout).issues[0].code, 'schema-unavailable');
});

// --- CLI: usage and I/O errors ----------------------------------------------

test('unknown commands, unknown flags, and missing maps exit 2', async (t) => {
  const root = await makeRegistry(t);
  const help = await runCli(['--help'], {cwd: root});
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node scripts\/skills-map-cli\.mjs/);
  assert.equal((await runCli(['frobnicate', '--root', root], {cwd: root})).code, 2);
  assert.equal((await runCli(['validate', '--bogus', '--root', root], {cwd: root})).code, 2);
  const empty = await tempDir(t, 'nosey-no-map-');
  const missing = await runCli(['add', 'always-recommend', 'x', '--root', empty, '--json'], {cwd: empty});
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stdout).issues[0].code, 'map-unreadable');
});

test('human mode prints readable reports and reminders', async (t) => {
  const root = await makeRegistry(t);
  const human = await runCli(['add', 'frontend-package', 'vite', '--root', root], {cwd: root});
  assert.equal(human.code, 0);
  assert.match(human.stdout, /Updated skills-map\.json \(1 operation\(s\)\)\./);
  assert.match(human.stderr, /Run node scripts\/generate\.mjs/);

  const noop = await runCli(['add', 'frontend-package', 'vite', '--root', root], {cwd: root});
  assert.equal(noop.code, 0);
  assert.match(noop.stdout, /No changes needed\./);
  assert.match(noop.stderr, /notice: frontend-package already present: vite/);

  const quiet = await runCli(['add', 'frontend-package', 'vite', '--quiet', '--root', root], {cwd: root});
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stderr.includes('notice:'), false);
});
