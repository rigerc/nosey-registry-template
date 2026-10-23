import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {test} from 'node:test';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const source = process.cwd();
const templateId = 'example/agent-skills';

// Isolate the fixture from this registry's identity, skills, and recommendations;
// the assertions below describe an empty template registry.
async function reset(root) {
  await writeFile(
    path.join(root, 'registry.json'),
    JSON.stringify({schemaVersion: 1, registryId: templateId}, null, 2) + '\n',
  );
  await writeFile(
    path.join(root, 'skills-manifest.json'),
    JSON.stringify({schemaVersion: 1, registryId: templateId, skills: []}, null, 2) + '\n',
  );
  await writeFile(
    path.join(root, 'skills-map.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        registryId: templateId,
        alwaysRecommend: [],
        externalSkills: [],
        technologies: [],
        technologySkills: [],
        combinations: [],
        combinationSkills: [],
        frontendBonusSkills: [],
        frontendPackages: [],
        webFrontendExtensions: [],
      },
      null,
      2,
    ) + '\n',
  );
  await rm(path.join(root, 'skills'), {recursive: true, force: true});
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nosey-template-'));
  try {
    for (const n of ['registry.json', 'skills-manifest.json', 'skills-map.json', 'README.md'])
      await cp(path.join(source, n), path.join(root, n));
    for (const n of ['scripts'])
      await cp(path.join(source, n), path.join(root, n), {recursive: true});
    await reset(root);
    await run(root);
  } finally { await rm(root, {recursive: true, force: true}); }
}
const json = async (root, file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const configure = (root, id) => exec(process.execPath, [
  path.join(root, 'scripts/configure-registry.mjs'), id
], {cwd: root});

test('configuration remaps local IDs and preserves external identities and annotations', async () => {
  await fixture(async (root) => {
    const oldId = (await json(root, 'registry.json')).registryId;
    const folder = path.join(root, 'skills', 'testing');
    await mkdir(folder, {recursive: true});
    await writeFile(path.join(folder, 'SKILL.md'),
      '---\nname: Testing\ndescription: Test skill\n---\n\n# Testing\n');
    const map = await json(root, 'skills-map.json');
    map.externalSkills = [{id:'acme/upstream/testing', name:'External',
      source:'acme/upstream', skill:'testing'}];
    map.alwaysRecommend = [oldId + '/testing', 'acme/upstream/testing'];
    map.technologySkills = [{technologyId:'react',skills:[oldId + '/testing']}];
    await writeFile(path.join(root, 'skills-map.json'), JSON.stringify(map, null, 2) + '\n');

    await configure(root, 'acme/team-skills');
    const config = await json(root, 'registry.json');
    const manifest = await json(root, 'skills-manifest.json');
    const updated = await json(root, 'skills-map.json');
    assert.equal(config.registryId, 'acme/team-skills');
    assert.equal(manifest.registryId, 'acme/team-skills');
    assert.equal(updated.registryId, 'acme/team-skills');
    assert.equal(Object.hasOwn(manifest, '$schema'), false);
    assert.equal(Object.hasOwn(updated, '$schema'), false);
    assert.deepEqual(manifest.skills.map((skill) => skill.id), ['acme/team-skills/testing']);
    assert.deepEqual(updated.alwaysRecommend, ['acme/team-skills/testing', 'acme/upstream/testing']);
    assert.deepEqual(updated.technologySkills[0].skills, ['acme/team-skills/testing']);
    assert.equal(updated.externalSkills[0].id, 'acme/upstream/testing');
    assert.match(await readFile(path.join(root, 'README.md'), 'utf8'), /Registry: acme\/team-skills/);
    await exec(process.execPath,
      [path.join(root, 'scripts/generate-manifest.mjs'), '--check'], {cwd: root});
    await exec(process.execPath,
      [path.join(root, 'scripts/generate-readme.mjs'), '--check'], {cwd: root});
    const before = await readFile(path.join(root, 'skills-map.json'), 'utf8');
    await configure(root, 'acme/team-skills');
    assert.equal(await readFile(path.join(root, 'skills-map.json'), 'utf8'), before);
  });
});

test('invalid identity does not modify registry documents', async () => {
  await fixture(async (root) => {
    const before = await readFile(path.join(root, 'registry.json'), 'utf8');
    await assert.rejects(configure(root, '../unsafe'));
    assert.equal(await readFile(path.join(root, 'registry.json'), 'utf8'), before);
  });
});
