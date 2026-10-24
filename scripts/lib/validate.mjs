// Registry validation: the latest Nosey JSON Schemas plus the integration rules
// that JSON Schema cannot express. This validates registry documents only —
// skill content, naming, descriptions, links, and instructions belong to agnix.
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {readJson} from './files.mjs';
import {MAP_SCHEMA_URL, MANIFEST_SCHEMA_URL} from './schema.mjs';

export const SCHEMA_MANIFEST_FILE = 'skills-manifest.schema.json';
export const SCHEMA_MAP_FILE = 'skills-map.schema.json';

const MCP_CONFIG_PATHS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.codex/config.toml'];
const MATCHER_KEYS = ['packages', 'pythonPackages', 'endpoints', 'serverNames', 'configFiles'];
const MAX_REGEX_UNITS = 512;

/** Fetches one public schema. Any failure is fatal: there is no cached fallback. */
export async function fetchSchema(url) {
  let response;

  try {
    response = await fetch(url, {signal: AbortSignal.timeout(15_000)});
  } catch (error) {
    throw new Error('Cannot fetch ' + url + ' (' + (error.message ?? error) + ')');
  }

  if (!response.ok) throw new Error('Cannot fetch ' + url + ' (HTTP ' + response.status + ')');

  try {
    return await response.json();
  } catch {
    throw new Error('Schema at ' + url + ' is not valid JSON');
  }
}

/**
 * Loads both schemas. `schemas` points at a local directory for tests and
 * offline fixtures only; otherwise the latest public Nosey schemas are fetched.
 */
export async function loadSchemas({schemas} = {}) {
  if (schemas) {
    const directory = path.resolve(schemas);

    return {
      manifest: await readJson(path.join(directory, SCHEMA_MANIFEST_FILE)),
      map: await readJson(path.join(directory, SCHEMA_MAP_FILE)),
      source: 'local directory ' + directory,
    };
  }

  const [manifest, map] = await Promise.all([
    fetchSchema(MANIFEST_SCHEMA_URL),
    fetchSchema(MAP_SCHEMA_URL),
  ]);

  return {manifest, map, source: 'latest Nosey schemas'};
}

function text(value, context) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(context + ' must be a nonempty string');

  return value;
}

function strings(value, context) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.length))
    throw new Error(context + ' must be an array of nonempty strings');

  return value;
}

function optionalStrings(value, context) {
  return value === undefined ? [] : strings(value, context);
}

function object(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(context + ' must be an object');

  return value;
}

function unique(values, context) {
  if (new Set(values).size !== values.length) throw new Error('Duplicate ' + context);
}

function regex(value, context) {
  const rule = object(value, context);

  if (typeof rule.source !== 'string' || (rule.flags !== undefined && typeof rule.flags !== 'string'))
    throw new Error(context + ' requires a string source and optional flags');

  // JSON Schema maxLength counts code points; the parser bounds UTF-16 code units.
  if (rule.source.length > MAX_REGEX_UNITS)
    throw new Error(context + ': regex source exceeds ' + MAX_REGEX_UNITS + ' UTF-16 code units');

  const flags = rule.flags ?? '';

  if (/[gy]/.test(flags)) throw new Error(context + ': stateful regex flags are not supported');

  try {
    return new RegExp(rule.source, flags);
  } catch (error) {
    throw new Error(context + ': ' + String(error));
  }
}

function contentBlock(value) {
  const block = object(value, 'configFileContent block');

  if (!Array.isArray(block.patterns) || !block.patterns.length || block.patterns.length > 64)
    throw new Error('configFileContent.patterns must be a nonempty array of at most 64 entries');

  for (const entry of block.patterns)
    if (typeof entry === 'string') continue;
    else regex(entry, 'content pattern');

  for (const key of ['files', 'sourceExtensions'])
    if (block[key] !== undefined) strings(block[key], key);

  for (const key of ['scanGradleLayout', 'scanDotNetLayout', 'allPatterns', 'maskStrings'])
    if (block[key] !== undefined && typeof block[key] !== 'boolean')
      throw new Error(key + ' must be a boolean');

  if (
    block.stripComments !== undefined &&
    !['code', 'hash', 'xml'].includes(block.stripComments)
  )
    throw new Error('Invalid stripComments');

  return block;
}

function mcpMatcher(value) {
  const input = object(value, 'mcpServers matcher');
  const found = {};

  for (const key of Object.keys(input))
    if (!MATCHER_KEYS.includes(key)) throw new Error('Unknown mcpServers matcher field: ' + key);

  for (const key of MATCHER_KEYS) {
    if (input[key] === undefined) continue;

    const values = strings(input[key], 'mcpServers.' + key);

    if (!values.length || values.length > 64)
      throw new Error('mcpServers.' + key + ' requires 1 to 64 entries');

    found[key] = values;
  }

  for (const file of found.configFiles ?? [])
    if (
      file.includes('\\') ||
      path.posix.isAbsolute(file) ||
      path.posix.normalize(file) !== file ||
      file.split('/').some((part) => part === '.' || part === '..') ||
      !MCP_CONFIG_PATHS.some((location) => file === location || file.endsWith('/' + location))
    )
      throw new Error('mcpServers.configFiles requires normalized project-relative MCP config paths');

  if (!found.packages && !found.pythonPackages && !found.endpoints && !found.serverNames)
    throw new Error('mcpServers matcher requires a package, endpoint, or serverName identity');

  return found;
}

function detect(value) {
  const input = object(value, 'technology.detect');
  const known = [
    'packages',
    'pythonPackages',
    'composerPackages',
    'goModules',
    'rustCrates',
    'elixirPackages',
    'configFiles',
    'fileExtensions',
    'gems',
    'packagePatterns',
    'configFileContent',
    'mcpServers',
  ];

  for (const key of Object.keys(input))
    if (!known.includes(key)) throw new Error('Unknown detection field: ' + key);

  for (const key of [
    'packages',
    'pythonPackages',
    'composerPackages',
    'goModules',
    'rustCrates',
    'elixirPackages',
    'configFiles',
    'fileExtensions',
    'gems',
  ])
    if (input[key] !== undefined) strings(input[key], 'detect.' + key);

  if (input.packagePatterns !== undefined) {
    if (!Array.isArray(input.packagePatterns))
      throw new Error('packagePatterns must be an array');

    for (const entry of input.packagePatterns) regex(entry, 'packagePattern');
  }

  if (input.configFileContent !== undefined) {
    const blocks = Array.isArray(input.configFileContent)
      ? input.configFileContent
      : [input.configFileContent];

    for (const block of blocks) contentBlock(block);
  }

  if (input.mcpServers !== undefined) {
    if (!Array.isArray(input.mcpServers) || input.mcpServers.length > 64)
      throw new Error('mcpServers must be an array with at most 64 matchers');

    for (const matcher of input.mcpServers) mcpMatcher(matcher);
  }

  return input;
}

/** GitHub remote spellings normalize to a single case-insensitive owner/repo identity. */
export function canonicalExternalSource(value) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*?)(?:\.git)?\/?$/i.exec(
      value,
    );

  if (!match)
    throw new Error(
      'External skill source must be a GitHub owner/repository or GitHub HTTPS/SSH URL: ' + value,
    );

  const [owner, repository] = match[1].split('/');

  if (!owner || !repository || repository === '..' || owner.endsWith('.') || repository.endsWith('.'))
    throw new Error('Invalid external skill source: ' + value);

  return owner.toLowerCase() + '/' + repository.toLowerCase();
}

function externalSkill(value) {
  const item = object(value, 'external skill');
  const id = text(item.id, 'external skill.id');

  if (
    !/^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(id) ||
    id.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Invalid external skill ID: ' + id);

  const source = text(item.source, 'external skill.source');

  canonicalExternalSource(source);

  const name = text(item.skill, 'external skill.skill');

  if (!/^[A-Za-z0-9_.@-]+$/.test(name) || name === '.' || name === '..')
    throw new Error('Invalid external skill name: ' + name);

  for (const key of Object.keys(item))
    if (!['id', 'name', 'description', 'source', 'skill'].includes(key))
      throw new Error('Unknown external skill field: ' + key);

  text(item.name, 'external skill.name');

  if (item.description !== undefined) text(item.description, 'external skill.description');

  return item;
}

/** Rejects absolute, unnormalized, or escaping manifest paths. */
export function safeSkillPath(value) {
  const name = text(value, 'skill.path');

  if (
    name.includes('\\') ||
    name.includes('\0') ||
    path.posix.isAbsolute(name) ||
    path.posix.normalize(name) !== name ||
    name.split('/').some((part) => part === '.' || part === '..') ||
    !name.endsWith('/SKILL.md')
  )
    throw new Error('Unsafe skill path: ' + name);

  return name;
}

function references(value, context) {
  return optionalStrings(value, context);
}

/** Every skill ID referenced by the map, in declaration order. */
export function mapReferences(map) {
  const found = [];

  found.push(...references(map.alwaysRecommend, 'alwaysRecommend'));

  for (const technology of map.technologies ?? [])
    found.push(...references(technology.skills, 'technology.skills'));

  for (const binding of map.technologySkills ?? [])
    found.push(...references(binding.skills, 'technologySkills.skills'));

  for (const combination of map.combinations ?? [])
    found.push(...references(combination.skills, 'combination.skills'));

  for (const binding of map.combinationSkills ?? [])
    found.push(...references(binding.skills, 'combinationSkills.skills'));

  found.push(...references(map.frontendBonusSkills, 'frontendBonusSkills'));

  return found;
}

async function checkSkillFiles(root, manifest) {
  for (const skill of manifest.skills) {
    const filename = safeSkillPath(skill.path);
    const absolute = path.join(root, filename);
    const info = await lstat(absolute).catch((error) => {
      if (error.code === 'ENOENT') return undefined;

      throw error;
    });

    if (!info) throw new Error('Skill file is missing: ' + filename);

    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Skill file must be a regular file, not a symlink: ' + filename);

    if (!path.resolve(absolute).startsWith(path.resolve(root) + path.sep))
      throw new Error('Skill file escapes the registry: ' + filename);
  }
}

function checkMap(map) {
  if (map.schemaVersion === 1 && map.externalSkills !== undefined)
    throw new Error('externalSkills requires skills-map.json schemaVersion 2');

  const external = (map.externalSkills ?? []).map((entry) => externalSkill(entry));

  unique(
    external.map((entry) => entry.id),
    'external skill IDs',
  );

  for (const technology of map.technologies ?? []) {
    text(technology.id, 'technology.id');
    text(technology.name, 'technology.name');
    detect(technology.detect ?? {});
    references(technology.skills, 'technology.skills');
  }

  for (const combination of map.combinations ?? []) {
    text(combination.id, 'combination.id');
    text(combination.name, 'combination.name');

    if (!strings(combination.requires, 'combination.requires').length)
      throw new Error('combination.requires must not be empty');

    references(combination.skills, 'combination.skills');
  }

  for (const binding of map.technologySkills ?? []) {
    text(binding.technologyId, 'technologySkills.technologyId');
    references(binding.skills, 'technologySkills.skills');
  }

  for (const binding of map.combinationSkills ?? []) {
    text(binding.combinationId, 'combinationSkills.combinationId');
    references(binding.skills, 'combinationSkills.skills');
  }

  unique(
    (map.technologies ?? []).map((entry) => entry.id),
    'technology IDs',
  );
  unique(
    (map.combinations ?? []).map((entry) => entry.id),
    'combination IDs',
  );
  unique(
    (map.technologySkills ?? []).map((entry) => entry.technologyId),
    'technology associations',
  );
  unique(
    (map.combinationSkills ?? []).map((entry) => entry.combinationId),
    'combination associations',
  );

  return external;
}

function checkReferences(map, manifest, external) {
  const declared = new Set([...manifest.skills.map((skill) => skill.id), ...external.map((e) => e.id)]);

  for (const id of mapReferences(map))
    if (!declared.has(id)) throw new Error('skills-map.json references unknown skill: ' + id);
}

/**
 * Validates skills-manifest.json and skills-map.json in `root`.
 * Never reads registry.json: an unsupported stray file is ignored silently.
 */
export async function validateRegistry(root, {schemas} = {}) {
  const manifest = await readJson(path.join(root, 'skills-manifest.json'));
  const map = await readJson(path.join(root, 'skills-map.json'));
  const loaded = await loadSchemas({schemas});

  const ajv = new Ajv2020({allErrors: true, strict: false, validateFormats: false});

  for (const [name, schema, document] of [
    ['skills-manifest.json', loaded.manifest, manifest],
    ['skills-map.json', loaded.map, map],
  ]) {
    const validate = ajv.compile(schema);

    if (!validate(document))
      throw new Error(
        name + ' does not match the schema:\n' + ajv.errorsText(validate.errors, {separator: '\n'}),
      );
  }

  if (manifest.registryId !== map.registryId)
    throw new Error('Manifest and map registry IDs must match');

  if (!Array.isArray(manifest.skills)) throw new Error('skills-manifest.json skills must be an array');

  for (const skill of manifest.skills) {
    text(skill.id, 'skill.id');
    text(skill.name, 'skill.name');
    safeSkillPath(skill.path);

    if (skill.description !== undefined) text(skill.description, 'skill.description');
  }

  unique(
    manifest.skills.map((skill) => skill.id),
    'skill IDs',
  );
  unique(
    manifest.skills.map((skill) => skill.path),
    'skill paths',
  );

  const external = checkMap(map);

  await checkSkillFiles(root, manifest);
  checkReferences(map, manifest, external);

  return {
    skills: manifest.skills.length,
    external: external.length,
    source: loaded.source,
  };
}
