// Repository invariants: the committed template ships no example skill, no
// legacy registry document, no vendored schema copy, and canonical annotations.
import assert from 'node:assert/strict';
import {access, readdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {canonicalManifestSchema, canonicalMapSchema} from './helpers.mjs';

const root = process.cwd();

async function json(relative) {
  const {readFile} = await import('node:fs/promises');

  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

test('skills-map.json carries the canonical latest schema URL', async () => {
  assert.equal((await json('skills-map.json')).$schema, canonicalMapSchema);
});

test('skills-manifest.json carries the canonical latest schema URL', async () => {
  assert.equal((await json('skills-manifest.json')).$schema, canonicalManifestSchema);
});

test('committed JSON uses the template identity', async () => {
  assert.equal((await json('skills-map.json')).registryId, 'example/agent-skills');
  assert.equal((await json('skills-manifest.json')).registryId, 'example/agent-skills');
});

test('skills/ holds only the placeholder file', async () => {
  assert.deepEqual(await readdir(path.join(root, 'skills')), ['.gitkeep']);
});

test('the template ships no registry.json', async () => {
  await assert.rejects(access(path.join(root, 'registry.json')));
});

test('legacy template paths are gone', async () => {
  for (const relative of [
    'TEMPLATE_UPDATES.md',
    'Makefile',
    'docs/plans',
    'schemas',
    '.github/workflows/registry-ci.yml',
    '.github/workflows/generate-catalog.yml',
  ])
    await assert.rejects(access(path.join(root, relative)), relative + ' should not exist');
});

test('no schema copies are vendored anywhere in the template', async () => {
  for (const relative of [
    'schemas/skills-manifest.schema.json',
    'schemas/skills-map.schema.json',
    'skills-manifest.schema.json',
    'skills-map.schema.json',
  ])
    await assert.rejects(access(path.join(root, relative)), relative + ' should not exist');
});

test('AGENTS.md is template-maintainer guidance with the downstream notice', async () => {
  const {readFile} = await import('node:fs/promises');
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');

  assert.match(
    agents,
    /If this repository was created from the template, replace this file with your registry's own `AGENTS\.md`\./,
    'AGENTS.md must open with the downstream replacement notice',
  );

  for (const heading of [
    '## What this repository is',
    '## Repository boundaries',
    '## Source of truth',
    '## Editing rules',
    '## Commands',
    '## Schema annotations',
    '## CI',
    '## Template sync',
    '## Safety',
    '## Done criteria',
  ])
    assert.ok(agents.includes(heading), 'AGENTS.md is missing ' + heading);

  assert.match(agents, /maintaining the template repository/);
});

test('AGENTS.md is excluded from template sync', async () => {
  const {readFile} = await import('node:fs/promises');
  const ignore = await readFile(path.join(root, '.templatesyncignore'), 'utf8');

  assert.ok(
    ignore.split('\n').includes('AGENTS.md'),
    '.templatesyncignore must list AGENTS.md so a downstream replacement is never overwritten',
  );
});

test('generated artifacts carry no registry.json instructions', async () => {
  const {readFile} = await import('node:fs/promises');

  for (const relative of ['README.md', 'CONTRIBUTING.md', 'AGENTS.md']) {
    const content = await readFile(path.join(root, relative), 'utf8');

    // Documentation may state that the file is unsupported; it must not present it as a source.
    for (const line of content.split('\n'))
      if (line.includes('registry.json'))
        assert.match(line, /no `registry\.json`|not `registry\.json`|`registry\.json`, or|unsupported/);
  }
});
