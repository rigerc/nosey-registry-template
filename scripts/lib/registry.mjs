// Registry documents: identity, generation, and configuration.
//
// `skills-map.json` is the canonical identity source. There is no `registry.json`
// document, no fallback path, and no migration: a stray file is ignored.
import path from 'node:path';
import {readJson, readText, serialize, writeJson} from './files.mjs';
import {generateReadme} from './readme.mjs';
import {composeDocument, MANIFEST_SCHEMA_URL} from './schema.mjs';
import {collectSkills} from './skills.mjs';

export const MAP = 'skills-map.json';
export const MANIFEST = 'skills-manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const MAP_SCHEMA_VERSIONS = [1, 2];

const REFERENCE_GROUPS = [
  ['alwaysRecommend', null],
  ['technologies', 'skills'],
  ['technologySkills', 'skills'],
  ['combinations', 'skills'],
  ['combinationSkills', 'skills'],
  ['frontendBonusSkills', null],
];

export function validRegistryId(value) {
  if (typeof value !== 'string') return false;

  const parts = value.split('/');

  return (
    parts.length === 2 &&
    /^[a-z\d][\w.-]*$/i.test(parts[0]) &&
    /^[\w.-]+$/.test(parts[1]) &&
    parts.every((part) => part !== '.' && part !== '..' && !part.endsWith('.'))
  );
}

function mappingGroup(map, key) {
  const value = map[key];

  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) throw new Error('skills-map.json ' + key + ' must be an array');

  return value;
}

function references(values, context) {
  if (values === undefined || values === null) return [];

  if (!Array.isArray(values)) throw new Error(context + ' must be an array');

  return values.map((id) => {
    if (typeof id !== 'string') throw new Error(context + ' entries must be skill IDs');

    return id;
  });
}

/** Every skill ID the map refers to, in declaration order. */
export function mapReferences(map) {
  const found = [];

  for (const [key, nested] of REFERENCE_GROUPS) {
    if (nested === null) {
      found.push(...references(map[key], key));

      continue;
    }

    for (const entry of mappingGroup(map, key))
      found.push(...references(entry.skills, key + '[].' + nested));
  }

  return found;
}

function externalIds(map) {
  return new Set(
    mappingGroup(map, 'externalSkills').map((skill) => {
      if (typeof skill?.id !== 'string' || !skill.id.trim())
        throw new Error('skills-map.json externalSkills entries require an id');

      return skill.id;
    }),
  );
}

export async function readMap(root) {
  const filename = path.join(root, MAP);
  const map = await readJson(filename);

  if (!MAP_SCHEMA_VERSIONS.includes(map?.schemaVersion))
    throw new Error(MAP + ' requires a supported schemaVersion (' + MAP_SCHEMA_VERSIONS.join(' or ') + ')');

  if (!validRegistryId(map.registryId))
    throw new Error(MAP + ' requires a registryId in owner/repository form');

  if (map.schemaVersion === 1 && map.externalSkills !== undefined)
    throw new Error(MAP + ' schemaVersion 2 is required to declare externalSkills');

  mappingGroup(map, 'externalSkills');

  return map;
}

export async function readManifest(root) {
  const manifest = await readJson(path.join(root, MANIFEST));

  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION)
    throw new Error(MANIFEST + ' requires schemaVersion ' + MANIFEST_SCHEMA_VERSION);

  if (!Array.isArray(manifest.skills)) throw new Error(MANIFEST + ' skills must be an array');

  return manifest;
}

/** Regenerates the manifest from skills-map.json identity and local frontmatter. */
export async function generateManifest(root, {check = false} = {}) {
  const map = await readMap(root);
  const filename = path.join(root, MANIFEST);
  const existing = await readJson(filename, {required: false});

  const document = composeDocument(existing, MANIFEST_SCHEMA_URL, {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    registryId: map.registryId,
    skills: await collectSkills(root, map.registryId),
  });

  const output = serialize(document);

  if (check) {
    const current = (await readText(filename, {required: false})) ?? '';

    if (output !== current)
      throw new Error(MANIFEST + ' is out of date; run npm run generate');

    return {count: document.skills.length, changed: false};
  }

  if (output !== (await readText(filename, {required: false}))) await writeJson(filename, document);

  return {count: document.skills.length, changed: true};
}

/** Fails when a map reference resolves to neither a local nor a declared external skill. */
export function assertResolved(map, manifest) {
  const declared = new Set([
    ...manifest.skills.map((skill) => skill.id),
    ...externalIds(map),
  ]);

  for (const id of mapReferences(map)) {
    if (!declared.has(id)) throw new Error('skills-map.json references unknown skill: ' + id);
  }
}

function rewriteMap(map, previous, requested) {
  const external = externalIds(map);
  const remap = (id) => {
    if (external.has(id) || !id.startsWith(previous + '/')) return id;

    return requested + id.slice(previous.length);
  };

  for (const [key, nested] of REFERENCE_GROUPS) {
    if (nested === null) {
      if (map[key] !== undefined && map[key] !== null)
        map[key] = references(map[key], key).map(remap);

      continue;
    }

    for (const entry of mappingGroup(map, key))
      if (Object.hasOwn(entry, 'skills'))
        entry.skills = references(entry.skills, key + '[].' + nested).map(remap);
  }

  map.registryId = requested;
}

/**
 * Rewrites the registry identity, then regenerates the manifest and README.
 * Preserves `$schema`, `externalSkills`, external IDs, and unknown keys.
 */
export async function configureRegistry(root, requested) {
  if (!validRegistryId(requested)) throw new Error('Registry ID must be owner/repository');

  const map = await readMap(root);
  const manifest = await readManifest(root);

  if (manifest.registryId !== map.registryId)
    throw new Error('Manifest and map registry IDs must match; nothing was changed');

  assertResolved(map, manifest);

  const previous = map.registryId;
  const before = serialize(map);

  rewriteMap(map, previous, requested);

  if (serialize(map) !== before) await writeJson(path.join(root, MAP), map);

  const {count} = await generateManifest(root, {check: false});

  await generateReadme(root, {check: false});

  const updated = await readMap(root);

  if (updated.registryId !== requested)
    throw new Error('Registry ID rewrite failed; expected ' + requested);

  const regenerated = await readManifest(root);

  if (regenerated.registryId !== requested)
    throw new Error('Manifest registry ID rewrite failed; expected ' + requested);

  assertResolved(updated, regenerated);

  return {previous, registryId: requested, count};
}
