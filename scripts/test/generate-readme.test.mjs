// The README generator replaces only the marker-delimited catalog and never
// rewrites surrounding documentation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {BEGIN, END} from '../lib/readme.mjs';
import {
  fixture,
  manifestDocument,
  mapDocument,
  readmeDocument,
  skill,
} from './helpers.mjs';

function catalogOf(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);

  assert.notEqual(start, -1, 'catalog markers are missing');
  assert.notEqual(end, -1, 'catalog markers are missing');

  return text.slice(start + BEGIN.length, end);
}

test('replaces only the marker-delimited section', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
  });

  t.after(registry.cleanup);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);

  const before = await registry.read('README.md');
  const result = registry.run('generate-readme.mjs');

  assert.equal(result.status, 0, result.stderr);

  const after = await registry.read('README.md');

  assert.equal(after.slice(0, after.indexOf(BEGIN)), before.slice(0, before.indexOf(BEGIN)));
  assert.equal(after.slice(after.indexOf(END)), before.slice(before.indexOf(END)));
  assert.match(catalogOf(after), /### \[One\]\(skills\/one\/SKILL\.md\)/);
  assert.match(catalogOf(after), /Registry: example\/agent-skills · 1 skill\./);
});

test('lists local skills, external skills, and recommendation conditions', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument({
      alwaysRecommend: ['example/agent-skills/one'],
      externalSkills: [
        {
          id: 'acme/upstream-skills/testing',
          name: 'Upstream testing',
          source: 'acme/upstream-skills',
          skill: 'testing',
        },
      ],
      technologies: [
        {id: 'react', name: 'React', detect: {packages: ['react']}, skills: []},
      ],
      technologySkills: [
        {technologyId: 'react', skills: ['acme/upstream-skills/testing']},
      ],
    }),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
  });

  t.after(registry.cleanup);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);

  const result = registry.run('generate-readme.mjs');

  assert.equal(result.status, 0, result.stderr);

  const catalog = catalogOf(await registry.read('README.md'));

  assert.match(catalog, /### \[One\]\(skills\/one\/SKILL\.md\)/);
  assert.match(catalog, /### \[Upstream testing\]\(https:\/\/github\.com\/acme\/upstream-skills\)/);
  assert.match(catalog, /External skill: testing\./);
  assert.match(catalog, /Always recommended/);
  assert.match(catalog, /React is detected \\\(npm packages: react\\\)/);
  assert.match(catalog, /2 skills\./);
});

test('renders an explicit empty catalog when no skills are registered', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-readme.mjs');

  assert.equal(result.status, 0, result.stderr);
  assert.match(catalogOf(await registry.read('README.md')), /No skills are registered\./);
});

test('--check fails on drift and passes when the catalog is current', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
  });

  t.after(registry.cleanup);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);

  const drift = registry.run('generate-readme.mjs', '--check');

  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /README\.md is out of date/);

  assert.equal(registry.run('generate-readme.mjs').status, 0);

  const current = registry.run('generate-readme.mjs', '--check');

  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /catalog is current/);
});

test('fails when the marker pair is missing or duplicated', async (t) => {
  const missing = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': '# No markers here\n',
  });

  t.after(missing.cleanup);

  const result = missing.run('generate-readme.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one ordered pair/);

  const duplicated = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': BEGIN + '\n' + END + '\n' + BEGIN + '\n' + END + '\n',
  });

  t.after(duplicated.cleanup);

  assert.equal(duplicated.run('generate-readme.mjs').status, 1);
});

test('reports a manifest and map identity mismatch instead of rendering a catalog', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument({registryId: 'example/one'}),
    'skills-manifest.json': manifestDocument({registryId: 'example/two'}),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-readme.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /registry IDs must match/);
});

test('rejects unknown arguments', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-readme.mjs', '--write');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --write/);
});
