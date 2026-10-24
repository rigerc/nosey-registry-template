import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'v1');
const cases = [
  'configure-success', 'v1-nullables', 'guide-user-preserved', 'guide-conflict', 'malformed-map',
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
  assert.ok(refs.includes('example/agent-skills/external/shared'));
  assert.equal(map.schemaVersion, 2);
  assert.equal(map.externalSkills[0].id, 'example/agent-skills/external/shared');
  const v1 = await json(path.join(root, 'v1-nullables/input/skills-map.json'));
  assert.equal(v1.schemaVersion, 1);
  assert.equal(Object.hasOwn(v1, 'externalSkills'), false);
  assert.equal(v1.frontendPackages, null);
  assert.equal(v1.webFrontendExtensions, null);
  assert.equal(manifest.skills.length, 2);
  const annotations = await json(path.join(root, 'schema-annotation-values.json'));
  assert.deepEqual(new Set(annotations.map((entry) => entry.type)), new Set(['string', 'object', 'array', 'number', 'boolean', 'null']));
  assert.deepEqual(annotations.map((entry) => entry.type), ['string', 'object', 'array', 'number', 'boolean', 'null']);
});

test('guide and README recognition contract is fixed', async () => {
  const maintainer = await readFile(path.join(root, 'maintainer-guide.md'), 'utf8');
  const downstream = await readFile(path.join(root, 'downstream-guide.md'), 'utf8');
  assert.ok(maintainer.startsWith('<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->\n'));
  assert.equal((maintainer.match(/<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->/g) ?? []).length, 1);
  assert.ok(downstream.startsWith('# Registry agent guide\n'));
  assert.equal(await readFile(path.join(root, 'configure-success/expected/AGENTS.md'), 'utf8'), downstream);
  const readme = await readFile(path.join(root, 'configure-success/input/README.md'), 'utf8');
  assert.equal((readme.match(/<!-- BEGIN GENERATED SKILL CATALOG -->/g) ?? []).length, 1);
  assert.equal((readme.match(/<!-- END GENERATED SKILL CATALOG -->/g) ?? []).length, 1);
});
