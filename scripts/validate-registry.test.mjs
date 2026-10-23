import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {validateRegistry} from './validate-registry.mjs';

const registryId = 'acme/skills';
const base = {
  config: {schemaVersion: 1, registryId},
  manifest: {schemaVersion: 1, registryId, skills: []},
  map: {schemaVersion: 2, registryId, externalSkills: [], alwaysRecommend: []},
};
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registry-check-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const data = structuredClone({...base, ...overrides});
  for (const [key, file] of [['config', 'registry.json'], ['manifest', 'skills-manifest.json'], ['map', 'skills-map.json']]) {
    await writeFile(path.join(root, file), JSON.stringify(data[key], null, 2) + '\n');
  }
  return root;
}
const skill = (name = 'review') => ({
  id: registryId + '/' + name, path: 'skills/' + name + '/SKILL.md',
  name: 'Review', description: 'Review code.',
});
async function addSkill(root, name = 'review') {
  const folder = path.join(root, 'skills', name);
  await mkdir(folder, {recursive: true});
  await writeFile(path.join(folder, 'SKILL.md'), '---\nname: Review\n---\nInstructions\n');
}
test('empty registry and external-only registries are supported', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await validateRegistry(root), {registryId, localSkills: 0, externalSkills: 0});
  const mapFile = path.join(root, 'skills-map.json');
  const map = JSON.parse(await readFile(mapFile, 'utf8'));
  map.externalSkills = [{id: 'upstream/tools/helper', name: 'Helper', source: 'upstream/tools', skill: 'helper'}];
  map.alwaysRecommend = ['upstream/tools/helper'];
  await writeFile(mapFile, JSON.stringify(map));
  assert.equal((await validateRegistry(root)).externalSkills, 1);
});
test('nested local skills and mapping references validate', async (t) => {
  const root = await fixture(t, {
    manifest: {...base.manifest, skills: [skill('nested/review')]},
    map: {...base.map, technologySkills: [{technologyId: 'react', skills: [registryId + '/nested/review']}]},
  });
  await addSkill(root, 'nested/review');
  assert.equal((await validateRegistry(root)).localSkills, 1);
});
test('rejects unknown recommendations and mixed identities', async (t) => {
  const root = await fixture(t, {map: {...base.map, alwaysRecommend: ['missing/skill']}});
  await assert.rejects(validateRegistry(root), /references unknown skill/);
  await writeFile(path.join(root, 'skills-map.json'), JSON.stringify({...base.map, registryId: 'other/repo'}));
  await assert.rejects(validateRegistry(root), /registryId mismatch/);
});
test('rejects paths that escape the registry and dangling skill files', async (t) => {
  const root = await fixture(t, {manifest: {...base.manifest, skills: [skill()]}});
  await assert.rejects(validateRegistry(root), /ENOENT/);
  await addSkill(root);
  await rm(path.join(root, 'skills', 'review', 'SKILL.md'));
  const foreign = path.join(root, 'foreign.md');
  await writeFile(foreign, 'content');
  await symlink(foreign, path.join(root, 'skills', 'review', 'SKILL.md'));
  await assert.rejects(validateRegistry(root), /Unsafe skill file/);
});
test('rejects duplicate identities and version incompatible external declarations', async (t) => {
  const root = await fixture(t, {manifest: {...base.manifest, skills: [skill(), skill()]}});
  await addSkill(root);
  await assert.rejects(validateRegistry(root), /Duplicate skill path/);
  const map = {...base.map, schemaVersion: 1, externalSkills: []};
  await writeFile(path.join(root, 'skills-manifest.json'), JSON.stringify(base.manifest));
  await writeFile(path.join(root, 'skills-map.json'), JSON.stringify(map));
  await assert.rejects(validateRegistry(root), /externalSkills requires/);
});
