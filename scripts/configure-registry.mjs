#!/usr/bin/env node
// oxlint-disable anti-slop/no-runtime-typeof -- Dependency-free decoder of registry JSON.
// Canonical implementation in Nosey. Template copies support manual configuration.
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const names = ['registry.json', 'skills-manifest.json', 'skills-map.json'];

function validId(id) {
  if (typeof id !== 'string') return false;
  const parts = id.split('/');

  return (
    parts.length === 2 &&
    /^[a-z\d][\w.-]*$/i.test(parts[0]) &&
    /^[\w.-]+$/.test(parts[1]) &&
    parts.every((part) => part !== '.' && part !== '..' && !part.endsWith('.'))
  );
}

async function document(root, name) {
  const filename = path.join(root, name);
  const info = await lstat(filename);

  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
    throw new Error('Invalid registry file: ' + name);

  return JSON.parse(await readFile(filename, 'utf8'));
}

async function put(root, name, value) {
  const filename = path.join(root, name);
  const temporary = filename + '.' + randomUUID() + '.tmp';

  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
    await rename(temporary, filename);
  } finally {
    await rm(temporary, {force: true});
  }
}

/** tools is explicit for trusted adapters; never derive it from registry data. */
export async function configureRegistry(root, requested, tools = toolDirectory) {
  if (!validId(requested)) throw new Error('Registry ID must be owner/repository');
  const [registry, manifest, map] = await Promise.all(names.map((name) => document(root, name)));

  if (
    registry?.schemaVersion !== 1 ||
    manifest?.schemaVersion !== 1 ||
    ![1, 2].includes(map?.schemaVersion) ||
    !validId(registry.registryId) ||
    manifest.registryId !== registry.registryId ||
    map.registryId !== registry.registryId ||
    !Array.isArray(manifest.skills)
  )
    throw new Error('Registry documents are inconsistent; nothing was changed');

  const previous = registry.registryId;
  const external = new Set((map.externalSkills ?? []).map((skill) => skill.id));

  const remap = (id) => {
    if (typeof id !== 'string') throw new Error('Skill reference must be text');

    return !external.has(id) && id.startsWith(previous + '/')
      ? requested + id.slice(previous.length)
      : id;
  };

  const references = (value) => {
    if (!Array.isArray(value)) throw new Error('Skill references must be an array');

    return value.map(remap);
  };

  for (const skill of manifest.skills) skill.id = remap(skill.id);

  for (const key of ['technologies', 'technologySkills', 'combinations', 'combinationSkills']) {
    if (map[key] === undefined || map[key] === null) continue;

    if (!Array.isArray(map[key])) throw new Error('Mapping group must be an array');

    for (const item of map[key]) {
      if (Object.hasOwn(item, 'skills')) item.skills = references(item.skills);
    }
  }

  for (const key of ['alwaysRecommend', 'frontendBonusSkills']) {
    if (map[key] !== undefined && map[key] !== null) map[key] = references(map[key]);
  }

  for (const value of [registry, manifest, map]) value.registryId = requested;

  // Validate every transformation before the first mutation; preserve raw annotations.
  for (const [index, name] of names.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await put(root, name, [registry, manifest, map][index]);
  }

  for (const name of ['generate-manifest.mjs', 'generate-readme.mjs']) {
    // eslint-disable-next-line no-await-in-loop
    await exec(process.execPath, [path.join(tools, name)], {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);

    if (args.length !== 1 && !(args.length === 3 && args[1] === '--root'))
      throw new Error(
        'Usage: node scripts/configure-registry.mjs owner/repository [--root directory]',
      );
    await configureRegistry(path.resolve(args[2] ?? process.cwd()), args[0]);
    console.log('Configured registry ' + args[0]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
