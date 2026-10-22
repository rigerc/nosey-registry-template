#!/usr/bin/env node
// Configure a registry made through GitHub's "Use this template" flow.
// Does not install skills, contact GitHub, or run skill files.
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import process from 'node:process';

const exec = promisify(execFile);
const root = process.cwd();
const requested = process.argv[2];

function validId(id) {
  if (typeof id !== 'string') return false;
  const parts = id.split('/');
  return parts.length === 2 &&
    /^[a-z\d][\w.-]*$/i.test(parts[0]) &&
    /^[\w.-]+$/.test(parts[1]) &&
    parts.every((p) => p !== '.' && p !== '..' && !p.endsWith('.'));
}
function remap(id, from, to, external) {
  if (typeof id !== 'string' || external.has(id)) return id;
  return id.startsWith(from + '/') ? to + id.slice(from.length) : id;
}
function mapRefs(value, from, to, external) {
  if (value === undefined) return value;
  if (!Array.isArray(value)) throw new Error('Skill references must be an array');
  return value.map((id) => remap(id, from, to, external));
}
function groups(items, from, to, external) {
  if (items === undefined || items === null) return;
  if (!Array.isArray(items)) throw new Error('Mapping group must be an array');
  for (const item of items) {
    if (item && Object.hasOwn(item, 'skills'))
      item.skills = mapRefs(item.skills, from, to, external);
  }
}
async function put(name, object) {
  const destination = path.join(root, name);
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(object, null, 2) + '\n', {flag: 'wx'});
    await rename(temporary, destination);
  } finally { await rm(temporary, {force: true}); }
}
async function main() {
  if (process.argv.length !== 3 || !validId(requested))
    throw new Error('Usage: node scripts/configure-registry.mjs owner/repository');

  const [registry, manifest, map] = await Promise.all(
    ['registry.json', 'skills-manifest.json', 'skills-map.json']
      .map(async (name) => JSON.parse(await readFile(path.join(root, name), 'utf8')))
  );
  if (registry.schemaVersion !== 1 || manifest.schemaVersion !== 1 ||
      ![1, 2].includes(map.schemaVersion) ||
      !validId(registry.registryId) ||
      manifest.registryId !== registry.registryId ||
      map.registryId !== registry.registryId ||
      !Array.isArray(manifest.skills)) {
    throw new Error('Registry documents are inconsistent; nothing was changed');
  }

  const previous = registry.registryId;
  const external = new Set((map.externalSkills ?? []).map((skill) => skill.id));
  for (const skill of manifest.skills) skill.id = remap(skill.id, previous, requested, external);
  for (const key of ['technologies', 'technologySkills', 'combinations', 'combinationSkills'])
    groups(map[key], previous, requested, external);
  for (const key of ['alwaysRecommend', 'frontendBonusSkills'])
    if (Object.hasOwn(map, key)) map[key] = mapRefs(map[key], previous, requested, external);

  registry.registryId = requested;
  manifest.registryId = requested;
  map.registryId = requested;
  await put('registry.json', registry);
  await put('skills-manifest.json', manifest);
  await put('skills-map.json', map);

  // Execute only the known local generators, not registry skill files.
  for (const name of ['generate-manifest.mjs', 'generate-readme.mjs']) {
    await exec(process.execPath, [path.join(root, 'scripts', name)], {
      cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024
    });
  }
  console.log('Configured registry ' + requested);
}
try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
