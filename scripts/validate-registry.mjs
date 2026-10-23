#!/usr/bin/env node
// Self-contained registry integrity checks. Never executes or downloads a skill.
import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.cwd());
const local = (name) => path.join(root, name);
const fail = (message) => { throw new Error(message); };

async function jsonFile(name) {
  const stat = await lstat(local(name));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    fail(name + ' must be a regular file smaller than 4 MiB');
  }
  return JSON.parse(await readFile(local(name), 'utf8'));
}

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(field + ' must be nonempty text');
  return value;
}
function list(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(field + ' must be an array');
  return value;
}
function refs(value, field, known) {
  for (const id of list(value, field)) {
    if (!known.has(nonempty(id, field))) fail(field + ' references unknown skill: ' + id);
  }
}
function inside(base, actual) {
  const relative = path.relative(base, actual);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function validPath(value) {
  nonempty(value, 'skill.path');
  if (!value.startsWith('skills/') || !value.endsWith('/SKILL.md') ||
    value.includes('\\') || value.includes('\0') ||
    path.posix.normalize(value) !== value ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('Unsafe skill path: ' + value);
  }
  return value;
}
function unique(items, field) {
  const known = new Set();
  for (const item of items) {
    if (known.has(item)) fail('Duplicate ' + field + ': ' + item);
    known.add(item);
  }
  return known;
}

export async function validateRegistry(directory = root) {
  const here = await realpath(directory);
  const load = async (name) => {
    const location = path.join(here, name);
    const stat = await lstat(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      fail(name + ' must be a regular file smaller than 4 MiB');
    }
    return JSON.parse(await readFile(location, 'utf8'));
  };
  const [config, manifest, map] = await Promise.all([
    load('registry.json'), load('skills-manifest.json'), load('skills-map.json'),
  ]);
  if (config?.schemaVersion !== 1 || manifest?.schemaVersion !== 1 ||
    ![1, 2].includes(map?.schemaVersion)) fail('Unsupported registry document schemaVersion');
  const id = nonempty(config.registryId, 'registryId');
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(id) ||
    id.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.'))) {
    fail('registryId must be owner/repository');
  }
  if (manifest.registryId !== id || map.registryId !== id) {
    fail('registryId mismatch across registry documents');
  }

  const skills = list(manifest.skills, 'manifest.skills');
  if (!Array.isArray(manifest.skills) || skills.length > 20_000) fail('Invalid manifest.skills');
  const ids = [];
  const paths = [];
  for (const skill of skills) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) fail('Invalid skill record');
    const filename = validPath(skill.path);
    const expected = id + '/' + filename.slice('skills/'.length, -'/SKILL.md'.length);
    if (skill.id !== expected) fail('Skill ID does not match path: ' + skill.id);
    nonempty(skill.name, filename + '.name');
    if (skill.description !== undefined) nonempty(skill.description, filename + '.description');
    ids.push(skill.id);
    paths.push(filename);
    const absolute = path.join(here, filename);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(here, await realpath(absolute))) {
      fail('Unsafe skill file: ' + filename);
    }
  }
  unique(paths, 'skill path');
  unique(ids, 'skill ID');

  if (map.schemaVersion === 1 && Object.hasOwn(map, 'externalSkills')) {
    fail('externalSkills requires skills-map.json schemaVersion 2');
  }
  const external = list(map.externalSkills, 'externalSkills');
  const externalIds = external.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Invalid external skill');
    nonempty(entry.name, 'external skill.name');
    nonempty(entry.source, 'external skill.source');
    nonempty(entry.skill, 'external skill.skill');
    const externalId = nonempty(entry.id, 'external skill.id');
    if (!/^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(externalId) ||
      externalId.split('/').some((part) => part === '.' || part === '..')) fail('Invalid external skill ID');
    return externalId;
  });
  const all = unique([...ids, ...externalIds], 'skill ID');

  refs(map.alwaysRecommend, 'alwaysRecommend', all);
  refs(map.frontendBonusSkills, 'frontendBonusSkills', all);
  for (const key of ['technologies', 'combinations', 'technologySkills', 'combinationSkills']) {
    for (const [index, record] of list(map[key], key).entries()) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Invalid ' + key + '[' + index + ']');
      refs(record.skills, key + '[' + index + '].skills', all);
    }
  }

  return {registryId: id, localSkills: ids.length, externalSkills: externalIds.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/validate-registry.mjs');
    process.exitCode = 1;
  } else {
    try {
      const result = await validateRegistry();
      console.log('Registry valid (' + result.localSkills + ' local; ' + result.externalSkills + ' external skills).');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
