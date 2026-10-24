// Identity configuration rewrites local IDs, preserves external identity and
// annotations, and is idempotent.
import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture, manifestDocument, mapDocument, readmeDocument, skill} from './helpers.mjs';

const previous = 'example/agent-skills';
const requested = 'acme/agent-skills';
const externalId = 'acme/upstream-skills/testing';

function populatedMap() {
  return {
    $schema: 'https://example.test/custom-map.json',
    schemaVersion: 2,
    registryId: previous,
    alwaysRecommend: [previous + '/one'],
    externalSkills: [
      {
        id: externalId,
        name: 'Upstream testing',
        source: 'acme/upstream-skills',
        skill: 'testing',
      },
    ],
    technologies: [
      {
        id: 'react',
        name: 'React',
        detect: {packages: ['react']},
        skills: [previous + '/group/two'],
      },
    ],
    technologySkills: [{technologyId: 'react', skills: [externalId, previous + '/one']}],
    combinations: [],
    combinationSkills: [{combinationId: 'react', skills: [previous + '/group/two']}],
    frontendBonusSkills: [previous + '/one'],
    frontendPackages: ['ink'],
    webFrontendExtensions: ['.tsx'],
    customField: {keep: true},
  };
}

async function populatedRegistry() {
  return fixture({
    'skills-map.json': populatedMap(),
    'skills-manifest.json': manifestDocument({
      $schema: 'https://example.test/custom-manifest.json',
      skills: [
        {id: previous + '/one', name: 'One', path: 'skills/one/SKILL.md', description: 'First.'},
        {
          id: previous + '/group/two',
          name: 'Two',
          path: 'skills/group/two/SKILL.md',
          description: 'Second.',
        },
      ],
    }),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
    'skills/group/two/SKILL.md': skill({name: 'Two', description: 'Second.'}),
  });
}

test('rewrites the identity and every local reference', async (t) => {
  const registry = await populatedRegistry();

  t.after(registry.cleanup);

  const result = registry.run('configure-registry.mjs', requested);

  assert.equal(result.status, 0, result.stderr);

  const map = await registry.json('skills-map.json');

  assert.equal(map.registryId, requested);
  assert.deepEqual(map.alwaysRecommend, [requested + '/one']);
  assert.deepEqual(map.technologies[0].skills, [requested + '/group/two']);
  assert.deepEqual(map.technologySkills[0].skills, [externalId, requested + '/one']);
  assert.deepEqual(map.combinationSkills[0].skills, [requested + '/group/two']);
  assert.deepEqual(map.frontendBonusSkills, [requested + '/one']);
});

test('preserves external skills, external IDs, $schema, and unknown keys', async (t) => {
  const registry = await populatedRegistry();

  t.after(registry.cleanup);

  assert.equal(registry.run('configure-registry.mjs', requested).status, 0);

  const map = await registry.json('skills-map.json');

  assert.deepEqual(map.externalSkills, populatedMap().externalSkills);
  assert.equal(map.technologySkills[0].skills[0], externalId);
  assert.equal(map.$schema, 'https://example.test/custom-map.json');
  assert.deepEqual(map.customField, {keep: true});
  assert.deepEqual(map.frontendPackages, ['ink']);
});

test('regenerates the manifest and README with the new identity', async (t) => {
  const registry = await populatedRegistry();

  t.after(registry.cleanup);

  assert.equal(registry.run('configure-registry.mjs', requested).status, 0);

  const manifest = await registry.json('skills-manifest.json');

  assert.equal(manifest.registryId, requested);
  assert.equal(manifest.$schema, 'https://example.test/custom-manifest.json');
  assert.deepEqual(
    manifest.skills.map((entry) => entry.id),
    [requested + '/group/two', requested + '/one'],
  );

  const readme = await registry.read('README.md');

  assert.match(readme, /Registry: acme\/agent-skills · 3 skills\./);
  assert.match(readme, /### \[One\]\(skills\/one\/SKILL\.md\)/);
  assert.match(readme, /### \[Two\]\(skills\/group\/two\/SKILL\.md\)/);
});

test('is idempotent', async (t) => {
  const registry = await populatedRegistry();

  t.after(registry.cleanup);

  assert.equal(registry.run('configure-registry.mjs', requested).status, 0);

  const map = await registry.read('skills-map.json');
  const manifest = await registry.read('skills-manifest.json');
  const readme = await registry.read('README.md');

  const again = registry.run('configure-registry.mjs', requested);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(await registry.read('skills-map.json'), map);
  assert.equal(await registry.read('skills-manifest.json'), manifest);
  assert.equal(await registry.read('README.md'), readme);
});

test('rejects an invalid identity without changing any document', async (t) => {
  const registry = await populatedRegistry();

  t.after(registry.cleanup);

  const map = await registry.read('skills-map.json');

  for (const value of ['acme', 'acme/', '/agent-skills', 'acme/agent-skills/extra', 'acme/.']) {
    const result = registry.run('configure-registry.mjs', value);

    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /owner\/repository/);
  }

  assert.equal(await registry.read('skills-map.json'), map);
});

test('rejects a manifest and map identity mismatch', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument({registryId: previous}),
    'skills-manifest.json': manifestDocument({registryId: 'other/registry'}),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  const result = registry.run('configure-registry.mjs', requested);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /registry IDs must match/);
  assert.equal((await registry.json('skills-map.json')).registryId, previous);
});

test('rejects a map that references an undeclared skill', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument({alwaysRecommend: [previous + '/missing']}),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  const result = registry.run('configure-registry.mjs', requested);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /references unknown skill/);
  assert.equal((await registry.json('skills-map.json')).registryId, previous);
});

test('requires exactly one positional identity argument', async (t) => {
  const registry = await populatedRegistry();

  t.after(registry.cleanup);

  const result = registry.run('configure-registry.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node scripts\/configure-registry\.mjs owner\/repository/);
});
