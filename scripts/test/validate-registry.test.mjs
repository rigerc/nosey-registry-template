// Validation covers the registry documents and integration rules only.
// Skill content is deliberately out of scope: agnix validates skills/**.
import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchSchema} from '../lib/validate.mjs';
import {fixture, manifestDocument, mapDocument, readmeDocument, skill} from './helpers.mjs';

const schemas = {
  'schemas/skills-manifest.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['schemaVersion', 'registryId', 'skills'],
    properties: {
      schemaVersion: {type: 'integer', const: 1},
      registryId: {type: 'string'},
      skills: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'path'],
          properties: {
            id: {type: 'string'},
            name: {type: 'string'},
            path: {type: 'string'},
            description: {type: 'string'},
          },
        },
      },
    },
  },
  'schemas/skills-map.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['schemaVersion', 'registryId'],
    properties: {
      schemaVersion: {type: 'integer'},
      registryId: {type: 'string'},
    },
  },
};

async function registry(files = {}, map = mapDocument(), manifest = manifestDocument()) {
  return fixture({
    ...schemas,
    'skills-map.json': map,
    'skills-manifest.json': manifest,
    'README.md': readmeDocument(),
    ...files,
  });
}

function validate(fixtureRegistry, ...args) {
  return fixtureRegistry.run('validate-registry.mjs', '--schemas', 'schemas', ...args);
}

test('validates a consistent registry with resolvable references', async (t) => {
  const registryFixture = await registry(
    {'skills/one/SKILL.md': skill({name: 'One', description: 'First.'})},
    mapDocument({
      alwaysRecommend: ['example/agent-skills/one'],
      externalSkills: [
        {
          id: 'acme/upstream-skills/testing',
          name: 'Upstream testing',
          source: 'https://github.com/acme/upstream-skills.git',
          skill: 'testing',
        },
      ],
      technologySkills: [{technologyId: 'react', skills: ['acme/upstream-skills/testing']}],
    }),
    manifestDocument({
      skills: [
        {id: 'example/agent-skills/one', name: 'One', path: 'skills/one/SKILL.md', description: 'First.'},
      ],
    }),
  );

  t.after(registryFixture.cleanup);

  const result = validate(registryFixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated 1 skills and 1 external skills/);
});

test('fails when a document violates the schema', async (t) => {
  const registryFixture = await registry(
    {'skills/one/SKILL.md': skill({name: 'One'})},
    mapDocument(),
    manifestDocument({skills: [{id: 'example/agent-skills/one', path: 'skills/one/SKILL.md'}]}),
  );

  t.after(registryFixture.cleanup);

  const result = validate(registryFixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the schema/);
});

test('fails when a declared skill file is missing', async (t) => {
  const registryFixture = await registry(
    {},
    mapDocument(),
    manifestDocument({skills: [{id: 'example/agent-skills/one', name: 'One', path: 'skills/one/SKILL.md'}]}),
  );

  t.after(registryFixture.cleanup);

  const result = validate(registryFixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Skill file is missing/);
});

test('fails on duplicate skill IDs and unsafe paths', async (t) => {
  const duplicate = await registry(
    {'skills/one/SKILL.md': skill({name: 'One'})},
    mapDocument(),
    manifestDocument({
      skills: [
        {id: 'example/agent-skills/one', name: 'One', path: 'skills/one/SKILL.md'},
        {id: 'example/agent-skills/one', name: 'One again', path: 'skills/one/SKILL.md'},
      ],
    }),
  );

  t.after(duplicate.cleanup);

  assert.match(validate(duplicate).stderr, /Duplicate skill IDs/);

  const unsafe = await registry(
    {},
    mapDocument(),
    manifestDocument({skills: [{id: 'example/agent-skills/../x', name: 'X', path: 'skills/../x/SKILL.md'}]}),
  );

  t.after(unsafe.cleanup);

  assert.match(validate(unsafe).stderr, /Unsafe skill path/);
});

test('fails when a map reference resolves to nothing', async (t) => {
  const registryFixture = await registry(
    {},
    mapDocument({alwaysRecommend: ['example/agent-skills/missing']}),
    manifestDocument(),
  );

  t.after(registryFixture.cleanup);

  const result = validate(registryFixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /references unknown skill/);
});

test('fails on invalid regex flags and oversized regex sources', async (t) => {
  const stateful = await registry(
    {},
    mapDocument({
      technologies: [
        {id: 'react', name: 'React', detect: {packagePatterns: [{source: '^react$', flags: 'g'}]}},
      ],
    }),
  );

  t.after(stateful.cleanup);

  assert.match(validate(stateful).stderr, /stateful regex flags/);

  const oversized = await registry(
    {},
    mapDocument({
      technologies: [
        {id: 'react', name: 'React', detect: {packagePatterns: [{source: 'a'.repeat(513)}]}},
      ],
    }),
  );

  t.after(oversized.cleanup);

  assert.match(validate(oversized).stderr, /UTF-16 code units/);
});

test('rejects externalSkills in a schemaVersion 1 map', async (t) => {
  const registryFixture = await registry(
    {},
    mapDocument({
      schemaVersion: 1,
      externalSkills: [
        {id: 'acme/upstream-skills/testing', name: 'T', source: 'acme/upstream-skills', skill: 'testing'},
      ],
    }),
  );

  t.after(registryFixture.cleanup);

  const result = validate(registryFixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /externalSkills requires skills-map\.json schemaVersion 2/);
});

test('rejects an invalid external source and an unnormalized MCP config path', async (t) => {
  const source = await registry(
    {},
    mapDocument({
      externalSkills: [
        {id: 'acme/upstream-skills/testing', name: 'T', source: 'https://gitlab.com/acme/x', skill: 'testing'},
      ],
    }),
  );

  t.after(source.cleanup);

  assert.match(validate(source).stderr, /External skill source must be a GitHub/);

  const config = await registry(
    {},
    mapDocument({
      technologies: [
        {
          id: 'react',
          name: 'React',
          detect: {mcpServers: [{serverNames: ['react'], configFiles: ['./.mcp.json']}]},
        },
      ],
    }),
  );

  t.after(config.cleanup);

  assert.match(validate(config).stderr, /normalized project-relative MCP config paths/);
});

test('ignores a stray registry.json', async (t) => {
  const registryFixture = await registry(
    {'registry.json': {schemaVersion: 1, registryId: 'stray/identity'}},
  );

  t.after(registryFixture.cleanup);

  const result = validate(registryFixture);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /registry\.json/);
});

test('fails closed when the schemas cannot be fetched', async () => {
  await assert.rejects(fetchSchema('http://127.0.0.1:9/schema.json'), /Cannot fetch/);
});

test('requires a directory for --schemas', async (t) => {
  const registryFixture = await registry();

  t.after(registryFixture.cleanup);

  const result = registryFixture.run('validate-registry.mjs', '--schemas');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--schemas requires a value/);
});
