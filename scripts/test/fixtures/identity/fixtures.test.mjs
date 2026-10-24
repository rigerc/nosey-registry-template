import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildManifest} from '../../../generate-manifest.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'v1');
const cases = [
  'configure-success', 'v1-nullables', 'guide-user-preserved', 'guide-conflict', 'guide-bom', 'json-bom', 'malformed-map',
  'identity-mismatch', 'path-mismatch', 'undeclared-reference', 'readme-missing',
  'readme-duplicate', 'readme-reversed', 'invalid-request', 'write-failure',
];

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

test('identity fixture inventory is complete and versioned', async () => {
  for (const name of cases) {
    const dir = path.join(root, name);
    const input = path.join(dir, 'input');
    const metadata = await json(path.join(input, 'case.json'));
    assert.equal(metadata.version, 1, `${name} fixture version`);
    assert.ok(['accept', 'reject', 'rollback'].includes(metadata.verdict), `${name} verdict`);
    assert.ok(metadata.layers && ['schema', 'parser', 'integration'].every((key) => key in metadata.layers));
    for (const file of metadata.inputs ?? []) {
      const info = await stat(path.join(input, file));
      assert.ok(info.isFile(), `${name} missing input ${file}`);
    }
    if (metadata.verdict === 'reject' || metadata.verdict === 'rollback') {
      assert.equal(metadata.unchangedOnReject, true, `${name} must promise unchanged inputs`);
      assert.ok(metadata.expectedError?.reason, `${name} must name expected failure`);
    }
    if (metadata.verdict === 'accept' && metadata.expectedFiles) {
      for (const file of metadata.expectedFiles) {
        const info = await stat(path.join(dir, 'expected', file));
        assert.ok(info.isFile(), `${name} missing expected ${file}`);
      }
      assert.equal(metadata.idempotency, 'byte-identical');
    }
  }
});

test('main fixture covers all map references and annotation JSON types', async () => {
  const map = await json(path.join(root, 'configure-success/input/skills-map.json'));
  const manifest = await json(path.join(root, 'configure-success/input/skills-manifest.json'));
  const refs = [
    map.alwaysRecommend, ...map.technologies.map((item) => item.skills),
    ...map.technologySkills.map((item) => item.skills), ...map.combinations.map((item) => item.skills),
    ...map.combinationSkills.map((item) => item.skills), map.frontendBonusSkills,
  ].flat();
  assert.ok(refs.some((id) => id === 'example/agent-skills/nested/tooling/lint'));
  assert.ok(refs.includes('example/agent-skills/shared'));
  assert.equal(map.schemaVersion, 2);
  assert.equal(map.technologies[0].id, 'custom-typescript');
  assert.equal(map.combinations[0].id, 'custom-react-typescript');
  assert.ok(map.combinations[0].requires.includes('react'), 'fixture exercises a built-in technology reference');
  assert.equal(map.externalSkills[0].id, 'example/agent-skills/shared');
  assert.ok(map.externalSkills[0].id.startsWith(map.registryId + '/'), 'external ID deliberately shares the former registry prefix');
  const v1 = await json(path.join(root, 'v1-nullables/input/skills-map.json'));
  assert.equal(v1.schemaVersion, 1);
  assert.equal(Object.hasOwn(v1, 'externalSkills'), false);
  assert.equal(v1.technologies, null);
  assert.equal(v1.combinations, null);
  assert.equal(Object.hasOwn(v1, 'externalSkills'), false);
  assert.equal(manifest.skills.length, 2);
  assert.deepEqual(manifest.diagnostics, {user: 'must survive'});
  assert.equal(Object.hasOwn(manifest, '__proto__'), true);
  assert.deepEqual(manifest.__proto__, {userMetadata: true});
  assert.deepEqual(manifest.constructor, {userMetadata: 'constructor survives'});
  assert.deepEqual(manifest.skills[0].diagnostics, {nested: 'preserve'});
  assert.equal(Object.hasOwn(manifest.skills[0], '__proto__'), true);
  assert.deepEqual(manifest.skills[0].__proto__, {nested: true});
  assert.deepEqual(manifest.skills[0].constructor, {nested: 'constructor survives'});
  const mainCase = await json(path.join(root, 'configure-success/input/case.json'));
  assert.deepEqual(mainCase.schemaDocuments, {map: 'pass', manifest: 'pass'});
  assert.deepEqual(mainCase.parserDocuments, {map: 'pass', manifest: 'pass'});
  assert.equal(mainCase.layers.schema, 'pass');
  assert.equal(mainCase.layers.parser, 'pass');
  const nullableCase = await json(path.join(root, 'v1-nullables/input/case.json'));
  assert.deepEqual(nullableCase.layers, {schema: 'pass', parser: 'pass', integration: 'not-applicable'});
  const annotations = await json(path.join(root, 'schema-annotation-values.json'));
  assert.deepEqual(new Set(annotations.map((entry) => entry.type)), new Set(['string', 'object', 'array', 'number', 'boolean', 'null']));
  assert.deepEqual(annotations.map((entry) => entry.type), ['string', 'object', 'array', 'number', 'boolean', 'null']);
  const encountered = new Set();
  for (const name of cases) {
    const input = path.join(root, name, 'input');
    for (const file of ['skills-map.json', 'skills-manifest.json']) {
      try {
        const document = await json(path.join(input, file));
        if (Object.hasOwn(document, '$schema')) {
          const value = document.$schema;
          encountered.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
  }
  assert.deepEqual([...encountered].sort(), ['array', 'boolean', 'null', 'number', 'object', 'string']);
  for (const name of ['configure-success', 'guide-user-preserved']) {
    const input = path.join(root, name, 'input');
    const expected = path.join(root, name, 'expected');
    for (const file of ['skills-map.json', 'skills-manifest.json']) {
      const before = await json(path.join(input, file));
      const after = await json(path.join(expected, file));
      assert.deepEqual(after.$schema, before.$schema, `${name}/${file} preserves $schema exactly`);
    }
  }
});

test('configure-success skill inputs and manifest order are deterministic', async () => {
  const release = await readFile(path.join(root, 'configure-success/input/skills/nested/release/SKILL.md'), 'utf8');
  const lint = await readFile(path.join(root, 'configure-success/input/skills/nested/tooling/lint/SKILL.md'), 'utf8');
  assert.match(release, /name: Nested Release/);
  assert.match(release, /description: Prepares releases\./);
  assert.match(lint, /name: Nested Tooling Lint/);
  assert.match(lint, /description: Checks nested tooling\./);
  const expected = await json(path.join(root, 'configure-success/expected/skills-manifest.json'));
  assert.deepEqual(expected.skills.map((skill) => skill.path), ['skills/nested/release/SKILL.md', 'skills/nested/tooling/lint/SKILL.md']);
  const input = path.join(root, 'configure-success/input');
  const map = await json(path.join(input, 'skills-map.json'));
  map.registryId = 'acme/team-skills';
  const generated = await buildManifest(input, map, expected);
  assert.deepEqual(generated, expected, 'manifest generator output must match independently reviewed, path-sorted fixture output');
  const preservedInput = path.join(root, 'guide-user-preserved/input');
  const preservedExpected = await json(path.join(root, 'guide-user-preserved/expected/skills-manifest.json'));
  const preservedMap = await json(path.join(preservedInput, 'skills-map.json'));
  preservedMap.registryId = 'acme/team-skills';
  assert.deepEqual(
    await buildManifest(preservedInput, preservedMap, preservedExpected),
    preservedExpected,
    'user-guide preservation case must also match deterministic manifest generation',
  );
});

test('guide and README recognition contract is fixed', async () => {
  const maintainer = await readFile(path.join(root, 'maintainer-guide.md'), 'utf8');
  const downstream = await readFile(path.join(root, 'downstream-guide.md'), 'utf8');
  assert.ok(maintainer.startsWith('<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->\n'));
  assert.equal((maintainer.match(/<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->/g) ?? []).length, 1);
  assert.ok(downstream.startsWith('# Registry agent guide\n'));
  assert.equal(await readFile(path.join(root, 'configure-success/expected/AGENTS.md'), 'utf8'), downstream);
  const readme = await readFile(path.join(root, 'configure-success/input/README.md'), 'utf8');
  assert.ok(readme.startsWith('\uFEFF'), 'shared positive README preserves an authored UTF-8 BOM');
  assert.equal((readme.match(/<!-- BEGIN GENERATED SKILL CATALOG -->/g) ?? []).length, 1);
  assert.equal((readme.match(/<!-- END GENERATED SKILL CATALOG -->/g) ?? []).length, 1);
});
