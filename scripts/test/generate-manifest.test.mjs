// The manifest generator reads metadata only: it derives identity from
// skills-map.json, never writes the map, and never judges skill content.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalManifestSchema,
  canonicalMapSchema,
  emptyRegistry,
  fixture,
  mapDocument,
  manifestDocument,
  readmeDocument,
  skill,
} from './helpers.mjs';

test('derives nested IDs from the map identity and sorts deterministically', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/zeta/SKILL.md': skill({name: 'Zeta', description: 'Zeta description.'}),
    'skills/group/alpha/SKILL.md': skill({name: 'Alpha', description: 'Alpha description.'}),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-manifest.mjs');

  assert.equal(result.status, 0, result.stderr);

  const manifest = await registry.json('skills-manifest.json');

  assert.equal(manifest.$schema, canonicalManifestSchema);
  assert.equal(manifest.registryId, 'example/agent-skills');
  assert.deepEqual(
    manifest.skills.map((entry) => [entry.id, entry.path, entry.name]),
    [
      ['example/agent-skills/group/alpha', 'skills/group/alpha/SKILL.md', 'Alpha'],
      ['example/agent-skills/zeta', 'skills/zeta/SKILL.md', 'Zeta'],
    ],
  );
});

test('is deterministic across repeated runs', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
    'skills/two/SKILL.md': skill({name: 'Two', description: 'Second.'}),
  });

  t.after(registry.cleanup);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);
  const first = await registry.read('skills-manifest.json');

  assert.equal(registry.run('generate-manifest.mjs').status, 0);
  assert.equal(await registry.read('skills-manifest.json'), first);
});

test('falls back to the directory name when the name is missing or blank', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/no-name/SKILL.md': skill({description: 'Has a description.'}),
    'skills/blank-name/SKILL.md': skill({name: '   ', description: 'Also has one.'}),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-manifest.mjs');

  assert.equal(result.status, 0, result.stderr);

  const manifest = await registry.json('skills-manifest.json');

  assert.deepEqual(
    manifest.skills.map((entry) => [entry.id, entry.name]),
    [
      ['example/agent-skills/blank-name', 'blank-name'],
      ['example/agent-skills/no-name', 'no-name'],
    ],
  );
});

test('omits a missing, blank, or non-string description without rejecting the skill', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/missing/SKILL.md': skill({name: 'Missing'}),
    'skills/blank/SKILL.md': skill({name: 'Blank', description: '  '}),
    'skills/number/SKILL.md': skill({name: 'Number', description: 42}),
    'skills/kept/SKILL.md': skill({name: 'Kept', description: 'Kept description.'}),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-manifest.mjs');

  assert.equal(result.status, 0, result.stderr);

  const byId = new Map(
    (await registry.json('skills-manifest.json')).skills.map((entry) => [entry.id, entry]),
  );

  assert.equal(byId.get('example/agent-skills/missing').description, undefined);
  assert.equal(byId.get('example/agent-skills/blank').description, undefined);
  assert.equal(byId.get('example/agent-skills/number').description, undefined);
  assert.equal(byId.get('example/agent-skills/kept').description, 'Kept description.');
});

test('preserves an existing $schema value verbatim, including a custom URL', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument({$schema: 'https://example.test/custom.json'}),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);
  assert.equal((await registry.json('skills-manifest.json')).$schema, 'https://example.test/custom.json');
});

test('adds the canonical annotation when the document declares none', async (t) => {
  const registry = await emptyRegistry();

  t.after(registry.cleanup);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);

  const manifest = await registry.json('skills-manifest.json');

  assert.equal(manifest.$schema, canonicalManifestSchema);
  assert.equal(manifest.$schema === canonicalMapSchema, false);
});

test('generates an empty manifest for a registry with no skills directory', async (t) => {
  const registry = await emptyRegistry();

  t.after(registry.cleanup);

  const result = registry.run('generate-manifest.mjs');

  assert.equal(result.status, 0, result.stderr);

  const manifest = await registry.json('skills-manifest.json');

  assert.deepEqual(manifest.skills, []);
  assert.equal(manifest.registryId, 'example/agent-skills');
});

test('--check fails on drift and passes when the manifest is current', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
  });

  t.after(registry.cleanup);

  const drift = registry.run('generate-manifest.mjs', '--check');

  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /out of date/);

  assert.equal(registry.run('generate-manifest.mjs').status, 0);

  const current = registry.run('generate-manifest.mjs', '--check');

  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /Manifest is current \(1 skills\)/);
});

test('never writes skills-map.json', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument({frontendPackages: ['ink']}),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/one/SKILL.md': skill({name: 'One', description: 'First.'}),
  });

  t.after(registry.cleanup);

  const before = await registry.read('skills-map.json');

  assert.equal(registry.run('generate-manifest.mjs').status, 0);
  assert.equal(await registry.read('skills-map.json'), before);
});

test('reports a missing YAML frontmatter block instead of silently omitting the skill', async (t) => {
  const registry = await fixture({
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
    'skills/broken/SKILL.md': '# No frontmatter\n',
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-manifest.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing YAML frontmatter/);
});

test('ignores a stray registry.json', async (t) => {
  const registry = await fixture({
    'registry.json': {schemaVersion: 1, registryId: 'stray/identity'},
    'skills-map.json': mapDocument(),
    'skills-manifest.json': manifestDocument(),
    'README.md': readmeDocument(),
  });

  t.after(registry.cleanup);

  const result = registry.run('generate-manifest.mjs');

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /registry\.json/);
  assert.equal((await registry.json('skills-manifest.json')).registryId, 'example/agent-skills');
});
