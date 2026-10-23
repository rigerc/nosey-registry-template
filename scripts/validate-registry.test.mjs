import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {validateRegistry} from './validate-registry.mjs';

const registryId = 'acme/_skills';
const documents = {
  'registry.json': {schemaVersion: 1, registryId},
  'skills-manifest.json': {schemaVersion: 1, registryId, skills: []},
  'skills-map.json': {schemaVersion: 2, registryId, alwaysRecommend: []},
};

// Small transport fixtures, not copies of Nosey's contract. Tests can change
// these schemas to prove validation follows the response instead of local rules.
const schemas = {
  'skills-manifest.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', required: ['schemaVersion', 'registryId', 'skills'],
    properties: {
      schemaVersion: {const: 1},
      registryId: {type: 'string', minLength: 1},
      skills: {type: 'array'},
    },
    'x-parserOnly': ['uniqueness'], 'x-normalization': 'Header contract',
  },
  'skills-map.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', required: ['schemaVersion', 'registryId'],
    properties: {
      schemaVersion: {enum: [1, 2]},
      registryId: {type: 'string', minLength: 1},
      alwaysRecommend: {type: 'array', items: {type: 'string'}},
    },
  },
};

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registry-schema-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, value] of Object.entries({...documents, ...overrides})) {
    await writeFile(path.join(root, name), JSON.stringify(value));
  }
  return root;
}

function requestSchemas(source = schemas, calls = []) {
  return async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://raw.githubusercontent.com');
    assert.equal(parsed.pathname.startsWith('/rigerc/nosey/main/schemas/registry/'), true);
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(url);
    return Response.json(source[path.basename(parsed.pathname)]);
  };
}

test('validates all three JSON documents against Nosey main without modifying them', async (t) => {
  const root = await fixture(t);
  const before = await Promise.all(Object.keys(documents).map((name) => readFile(path.join(root, name), 'utf8')));
  const calls = [];
  await validateRegistry(root, requestSchemas(schemas, calls));
  assert.equal(calls.length, 2);
  assert.deepEqual(await Promise.all(Object.keys(documents).map((name) => readFile(path.join(root, name), 'utf8'))), before);
});

test('rejects invalid data in each document with the filename and schema diagnostic', async (t) => {
  for (const [name, value, expected] of [
    ['registry.json', {schemaVersion: 3, registryId}, /registry\.json.*constant/],
    ['registry.json', null, /registry\.json.*object/],
    ['skills-manifest.json', {schemaVersion: 1, registryId}, /skills-manifest\.json.*skills/],
    ['skills-manifest.json', {...documents['skills-manifest.json'], skills: false}, /skills-manifest\.json.*array/],
    ['skills-map.json', {...documents['skills-map.json'], alwaysRecommend: null}, /skills-map\.json.*array/],
    ['skills-map.json', {...documents['skills-map.json'], schemaVersion: 3}, /skills-map\.json.*allowed values/],
  ]) {
    const root = await fixture(t, {[name]: value});
    await assert.rejects(validateRegistry(root, requestSchemas()), expected);
  }
});

test('fetches fresh schemas on every call and immediately applies new constraints', async (t) => {
  const root = await fixture(t);
  const current = structuredClone(schemas);
  const calls = [];
  const request = requestSchemas(current, calls);
  await validateRegistry(root, request);
  current['skills-map.schema.json'].required.push('newRequiredField');
  current['skills-map.schema.json'].properties.newRequiredField = {type: 'string'};
  await assert.rejects(validateRegistry(root, request), /skills-map\.json.*newRequiredField/);
  assert.equal(calls.length, 4);
});

test('does not fetch document annotations or add parser and cross-document restrictions', async (t) => {
  const root = await fixture(t, {
    'registry.json': {...documents['registry.json'], $schema: 'https://example.com/untrusted'},
    'skills-manifest.json': {...documents['skills-manifest.json'], registryId: 'another ID',
      skills: [{id: 'custom', name: 'Data only', path: 'missing/SKILL.md'}]},
    'skills-map.json': {...documents['skills-map.json'], alwaysRecommend: ['not-declared']},
  });
  await validateRegistry(root, requestSchemas());
});

test('reports missing files and malformed JSON', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'skills-map.json'), '{broken');
  await assert.rejects(validateRegistry(root, requestSchemas()), /Cannot read skills-map\.json/);
  await rm(path.join(root, 'registry.json'));
  await assert.rejects(validateRegistry(root, requestSchemas()), /Cannot read registry\.json/);
});

test('fails when latest schemas cannot be loaded instead of using stale validation', async (t) => {
  const root = await fixture(t);
  await validateRegistry(root, requestSchemas());
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(validateRegistry(root, async () => new Response('', {status})),
      new RegExp('Cannot load latest Nosey schema.*HTTP ' + status));
  }
  await assert.rejects(validateRegistry(root, async () => {throw new Error('offline');}),
    /Cannot load latest Nosey schema.*offline/);
  await assert.rejects(validateRegistry(root, async () => {throw new DOMException('timed out', 'TimeoutError');}),
    /Cannot load latest Nosey schema.*timed out/);
  await assert.rejects(validateRegistry(root, async () => new Response('invalid json')),
    /Cannot load latest Nosey schema/);
});

test('rejects an invalid upstream schema', async (t) => {
  const root = await fixture(t);
  const invalid = structuredClone(schemas);
  invalid['skills-map.schema.json'].properties.alwaysRecommend.type = 'invalid-type';
  await assert.rejects(validateRegistry(root, requestSchemas(invalid)), /schema is invalid/);
});
