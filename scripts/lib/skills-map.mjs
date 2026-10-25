// Shared core for the skills-map CLI: bounded reading, offline parser-rule
// checks, schema-driven checks, idempotent mutations, and atomic writing of
// skills-map.json. Schema documents are always injected, never vendored.
import {randomUUID} from 'node:crypto';
import {lstat, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {validateSchema} from './schema-validator.mjs';

export const MAP_FILE = 'skills-map.json';
export const MANIFEST_FILE = 'skills-manifest.json';
export const MAP_SCHEMA_URL = 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json';
export const JSON_LIMIT = 4 * 1024 * 1024;

// Canonical top-level key order used by createMapDocument; edits preserve the
// existing order and only append keys the map did not have yet.
export const CANONICAL_KEY_ORDER = Object.freeze([
  '$schema', 'schemaVersion', 'registryId', 'alwaysRecommend', 'externalSkills',
  'technologies', 'technologySkills', 'combinations', 'combinationSkills',
  'frontendBonusSkills', 'frontendPackages', 'webFrontendExtensions',
]);

const EXTERNAL_ID_RE = /^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/;
const EXTERNAL_SKILL_RE = /^[A-Za-z0-9_.@-]+$/;
const EXTERNAL_SOURCE_RE = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*?)(?:\.git)?\/?$/i;
const REGISTRY_ID_RE = /^[\w.-]+\/[\w.-]+$/u;
const MCP_CONFIG_BASENAMES = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.codex/config.toml'];
const DETECT_STRING_FIELDS = ['packages', 'pythonPackages', 'composerPackages', 'goModules', 'rustCrates', 'elixirPackages', 'configFiles', 'fileExtensions', 'gems'];
const DETECT_ALLOWED_FIELDS = new Set([...DETECT_STRING_FIELDS, 'packagePatterns', 'configFileContent', 'mcpServers']);
const MCP_MATCHER_FIELDS = ['packages', 'pythonPackages', 'endpoints', 'serverNames', 'configFiles'];

const SEVERITIES = new Set(['error', 'warning', 'notice']);
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function issue(severity, code, at, message) {
  if (!SEVERITIES.has(severity)) throw new Error(`invalid issue severity: ${severity}`);
  return {severity, code, path: at, message};
}

export function parseJsonDocument(textValue, name) {
  try { return JSON.parse(textValue); } catch (error) { throw new Error(`Invalid JSON in ${name}: ${error.message}`); }
}

export function isValidRegistryId(value) {
  return typeof value === 'string' && REGISTRY_ID_RE.test(value);
}

export async function readMapFile(root) {
  const file = path.join(path.resolve(root), MAP_FILE);
  let info;
  try { info = await lstat(file); } catch (error) { throw new Error(`Cannot read ${MAP_FILE}: ${error.message}`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > JSON_LIMIT) throw new Error(`Invalid registry document: ${MAP_FILE}`);
  return parseJsonDocument(await readFile(file, 'utf8'), MAP_FILE);
}

export async function readManifestDocument(root) {
  const file = path.join(path.resolve(root), MANIFEST_FILE);
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return {missing: true};
    throw new Error(`Cannot read ${MANIFEST_FILE}: ${error.message}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > JSON_LIMIT) throw new Error(`Invalid registry document: ${MANIFEST_FILE}`);
  return {manifest: parseJsonDocument(await readFile(file, 'utf8'), MANIFEST_FILE)};
}

/** Local skill IDs from the manifest, when readable; warnings instead of failures so edits can proceed. */
export async function readManifestSkillIds(root) {
  try {
    const state = await readManifestDocument(root);
    if (state.missing) return {ids: null, warning: `${MANIFEST_FILE} not found; local skill references are not verified`};
    const skills = state.manifest?.skills;
    if (!Array.isArray(skills)) return {ids: null, warning: `${MANIFEST_FILE} has no skills array; local skill references are not verified`};
    const ids = skills.filter((entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id).map((entry) => entry.id);
    return {ids: new Set(ids), warning: undefined};
  } catch (error) {
    return {ids: null, warning: `${error.message} (local skill references are not verified)`};
  }
}

export function builtinIdSet(inventory) {
  if (!Array.isArray(inventory)) return null;
  const set = new Set();
  for (const item of inventory) if (isRecord(item) && typeof item.id === 'string' && item.id) set.add(item.id);
  return set;
}

/** Structural validation against an injected schema document. */
export function checkMapAgainstSchema(map, schema) {
  const result = validateSchema(schema, map);
  return result.errors.map((e) => issue('error', 'schema', e.path, `[${e.keyword}] ${e.message}`));
}

function checkExternalSource(source) {
  const match = EXTERNAL_SOURCE_RE.exec(source);
  if (!match) return false;
  const [owner, repo] = match[1].split('/');
  return Boolean(owner && repo && repo !== '..' && !owner.endsWith('.') && !repo.endsWith('.'));
}

/**
 * Offline parser-rule and reference checks mirroring the Nosey parser contract
 * the schema delegates to the parser. Never throws; returns structured issues.
 * - localSkillIds: Set of local skill IDs when the manifest is available
 *   (undeclared references are reported, null downgrades them to warnings).
 * - undeclaredSkillSeverity: severity for undeclared references against a
 *   manifest; edits pass "warning" because the manifest may be stale by
 *   design until regeneration, validate passes "error".
 * - builtinTechnologies/builtinCombinations: Sets from the schema inventories
 *   when known (unknown references are errors), null to downgrade to warnings.
 */
export function checkMapDocument(map, {localSkillIds = null, undeclaredSkillSeverity = 'error', builtinTechnologies = null, builtinCombinations = null} = {}) {
  const issues = [];
  const error = (code, at, message) => issues.push(issue('error', code, at, message));
  const warning = (code, at, message) => issues.push(issue('warning', code, at, message));

  if (!isRecord(map)) { error('map-type', '', 'skills-map.json must be a JSON object'); return issues; }

  const textValue = (value, at, code, label) => {
    if (typeof value !== 'string' || value.trim() === '') { error(code, at, `${label} must be a nonempty string`); return undefined; }
    return value;
  };
  const stringListItems = (value, at, label) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) { error('string-list', at, `${label} must be an array of nonempty strings`); return null; }
    return value;
  };
  const regexRule = (value, at) => {
    if (!isRecord(value)) { error('type', at, `${at} must be a regex object with a source`); return; }
    const {source, flags = ''} = value;
    if (typeof source !== 'string' || typeof flags !== 'string') { error('type', at, `${at} requires a string source and optional string flags`); return; }
    if (source.length > 512) error('regex', at, `${at} source exceeds 512 UTF-16 code units`);
    if (/[gy]/.test(flags)) error('regex', at, `${at} uses unsupported stateful regex flags`);
    else if (!/^[dimsuv]*$/.test(flags)) error('regex', at, `${at} uses unsupported regex flags`);
    try { new RegExp(source, flags); } catch (err) { error('regex', at, `${at} is invalid: ${err.message}`); }
  };
  const checkDetectConfig = (detect, at) => {
    if (!isRecord(detect)) { error('type', at, `${at} must be an object`); return; }
    for (const key of Object.keys(detect)) if (!DETECT_ALLOWED_FIELDS.has(key)) error('detect-unknown-field', `${at}/${key}`, `Unknown detection field: ${key}`);
    for (const key of DETECT_STRING_FIELDS) if (detect[key] !== undefined) stringListItems(detect[key], `${at}/${key}`, `detect ${key}`);
    if (detect.packagePatterns !== undefined) {
      if (!Array.isArray(detect.packagePatterns)) error('type', `${at}/packagePatterns`, 'detect packagePatterns must be an array');
      else detect.packagePatterns.forEach((rule, i) => regexRule(rule, `${at}/packagePatterns/${i}`));
    }
    if (detect.configFileContent !== undefined) {
      const raw = detect.configFileContent;
      const blocks = Array.isArray(raw) ? raw : [raw];
      if (!Array.isArray(raw) && !isRecord(raw)) error('type', `${at}/configFileContent`, 'detect configFileContent must be an object or array of objects');
      else for (const [i, blockValue] of blocks.entries()) {
        const blockAt = `${at}/configFileContent${Array.isArray(raw) ? `/${i}` : ''}`;
        if (!isRecord(blockValue)) { error('type', blockAt, `${blockAt} must be an object`); continue; }
        const patterns = blockValue.patterns;
        if (!Array.isArray(patterns) || patterns.length < 1 || patterns.length > 64) error('string-list', `${blockAt}/patterns`, `${blockAt} patterns must contain 1 to 64 entries`);
        else patterns.forEach((pattern, j) => { if (typeof pattern !== 'string') regexRule(pattern, `${blockAt}/patterns/${j}`); });
        for (const key of ['files', 'sourceExtensions']) if (blockValue[key] !== undefined) stringListItems(blockValue[key], `${blockAt}/${key}`, `${blockAt} ${key}`);
        for (const key of ['scanGradleLayout', 'scanDotNetLayout', 'allPatterns', 'maskStrings']) if (blockValue[key] !== undefined && typeof blockValue[key] !== 'boolean') error('type', `${blockAt}/${key}`, `${blockAt} ${key} must be boolean`);
        if (blockValue.stripComments !== undefined && !['code', 'hash', 'xml'].includes(blockValue.stripComments)) error('enum', `${blockAt}/stripComments`, `${blockAt} stripComments must be one of code, hash, xml`);
      }
    }
    if (detect.mcpServers !== undefined) {
      if (!Array.isArray(detect.mcpServers) || detect.mcpServers.length > 64) error('type', `${at}/mcpServers`, `${at} mcpServers must be an array with at most 64 matchers`);
      else for (const [i, matcherValue] of detect.mcpServers.entries()) {
        const mAt = `${at}/mcpServers/${i}`;
        if (!isRecord(matcherValue)) { error('type', mAt, `${mAt} must be an object`); continue; }
        for (const key of Object.keys(matcherValue)) if (!MCP_MATCHER_FIELDS.includes(key)) error('detect-unknown-field', `${mAt}/${key}`, `Unknown mcpServers matcher field: ${key}`);
        for (const key of MCP_MATCHER_FIELDS) if (matcherValue[key] !== undefined) {
          const items = stringListItems(matcherValue[key], `${mAt}/${key}`, `${mAt} ${key}`);
          if (items && (items.length < 1 || items.length > 64)) error('string-list', `${mAt}/${key}`, `${mAt} ${key} requires 1 to 64 entries`);
        }
        for (const file of matcherValue.configFiles ?? []) {
          if (typeof file !== 'string' || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file)
            || path.posix.normalize(file) !== file || file.split('/').some((part) => part === '.' || part === '..' || part === '')
            || !MCP_CONFIG_BASENAMES.some((base) => file === base || file.endsWith('/' + base))) {
            error('mcp-config-file', `${mAt}/configFiles`, `Invalid mcpServers.configFiles path: ${file}`);
            break;
          }
        }
        if (!['packages', 'pythonPackages', 'endpoints', 'serverNames'].some((key) => Array.isArray(matcherValue[key]) && matcherValue[key].length > 0)) {
          error('mcp-matcher-identity', mAt, `${mAt} requires a package, pythonPackage, endpoint, or serverName identity`);
        }
      }
    }
  };

  // schemaVersion and registryId
  const version = map.schemaVersion;
  if (version !== 1 && version !== 2) error('schema-version', '/schemaVersion', `schemaVersion must be 1 or 2 (found ${JSON.stringify(version)})`);
  if (version === 1 && Object.hasOwn(map, 'externalSkills')) error('external-skills-requires-v2', '/externalSkills', 'externalSkills requires skills-map.json schemaVersion 2');
  const registryId = textValue(map.registryId, '/registryId', 'registry-id', 'registryId');
  if (registryId !== undefined && !isValidRegistryId(registryId)) warning('registry-id-shape', '/registryId', 'registryId should use the owner/repository shape');

  // Strict string lists: absent is empty; null is rejected.
  const skillRefs = [];
  for (const key of ['alwaysRecommend', 'frontendBonusSkills', 'frontendPackages', 'webFrontendExtensions']) {
    if (!Object.hasOwn(map, key)) continue;
    const items = stringListItems(map[key], `/${key}`, key);
    if (items && (key === 'alwaysRecommend' || key === 'frontendBonusSkills')) {
      for (const [i, id] of items.entries()) skillRefs.push({at: `${key}/${i}`, id});
    }
  }

  // Normalized record lists: absent or null is an empty list.
  const normalizedList = (key) => {
    if (!Object.hasOwn(map, key) || map[key] === null) return [];
    if (!Array.isArray(map[key])) { error('type', `/${key}`, `${key} must be an array`); return null; }
    return map[key];
  };
  const externalSkills = version === 1 ? null : normalizedList('externalSkills');
  if (externalSkills && externalSkills.length > 20_000) error('max-items', '/externalSkills', 'externalSkills must contain at most 20000 entries');
  const technologies = normalizedList('technologies');
  const combinations = normalizedList('combinations');

  const externalIds = new Set();
  if (externalSkills) for (const [i, value] of externalSkills.entries()) {
    const at = `externalSkills/${i}`;
    if (!isRecord(value)) { error('type', at, 'external skill must be an object'); continue; }
    for (const key of Object.keys(value)) if (!['id', 'name', 'description', 'source', 'skill'].includes(key)) error('external-skill-unknown-field', `${at}/${key}`, `Unknown external skill field: ${key}`);
    const id = textValue(value.id, `${at}/id`, 'text', 'external skill.id');
    if (id !== undefined) {
      if (!EXTERNAL_ID_RE.test(id) || id.split('/').some((segment) => segment === '.' || segment === '..')) error('pattern', `${at}/id`, `Invalid external skill ID: ${id}`);
      else if (externalIds.has(id)) error('unique', `${at}/id`, `Duplicate external skill ID: ${id}`);
      else externalIds.add(id);
    }
    textValue(value.name, `${at}/name`, 'text', 'external skill.name');
    const skillName = textValue(value.skill, `${at}/skill`, 'text', 'external skill.skill');
    if (skillName !== undefined && (!EXTERNAL_SKILL_RE.test(skillName) || skillName === '.' || skillName === '..')) error('pattern', `${at}/skill`, `Invalid external skill name: ${skillName}`);
    const source = textValue(value.source, `${at}/source`, 'text', 'external skill.source');
    if (source !== undefined && !checkExternalSource(source)) error('pattern', `${at}/source`, `External skill source must be a GitHub owner/repository or GitHub HTTPS/SSH URL: ${source}`);
    if (value.description !== undefined) textValue(value.description, `${at}/description`, 'text', 'external skill.description');
  }

  const declaredTechnologies = new Set();
  const declaredCombinations = new Set();
  if (technologies) for (const [i, value] of technologies.entries()) {
    const at = `technologies/${i}`;
    if (!isRecord(value)) { error('type', at, 'technology must be an object'); continue; }
    const id = textValue(value.id, `${at}/id`, 'text', 'technology.id');
    if (id !== undefined) {
      if (declaredTechnologies.has(id)) error('unique', `${at}/id`, `Duplicate technology ID: ${id}`);
      else declaredTechnologies.add(id);
      if (builtinTechnologies?.has(id)) error('builtin-conflict', `${at}/id`, `Technology ID conflicts with a built-in technology: ${id}`);
    }
    textValue(value.name, `${at}/name`, 'text', 'technology.name');
    if (value.detect === undefined) error('required', `${at}/detect`, 'technology.detect is required');
    else checkDetectConfig(value.detect, `${at}/detect`);
    if (value.skills !== undefined) {
      const items = stringListItems(value.skills, `${at}/skills`, 'technology.skills');
      if (items) for (const [j, ref] of items.entries()) skillRefs.push({at: `${at}/skills/${j}`, id: ref});
    }
  }
  if (combinations) for (const [i, value] of combinations.entries()) {
    const at = `combinations/${i}`;
    if (!isRecord(value)) { error('type', at, 'combination must be an object'); continue; }
    const id = textValue(value.id, `${at}/id`, 'text', 'combination.id');
    if (id !== undefined) {
      if (declaredCombinations.has(id)) error('unique', `${at}/id`, `Duplicate combination ID: ${id}`);
      else declaredCombinations.add(id);
      if (builtinCombinations?.has(id)) error('builtin-conflict', `${at}/id`, `Combination ID conflicts with a built-in combination: ${id}`);
    }
    textValue(value.name, `${at}/name`, 'text', 'combination.name');
    if (value.requires === undefined) error('required', `${at}/requires`, 'combination.requires is required');
    else {
      const items = stringListItems(value.requires, `${at}/requires`, 'combination.requires');
      if (items) for (const [j, requirement] of items.entries()) {
        if (declaredTechnologies.has(requirement) || builtinTechnologies?.has(requirement)) continue;
        const message = `Unknown technology in combination ${id}: ${requirement}`;
        if (builtinTechnologies) error('unknown-technology', `${at}/requires/${j}`, message);
        else warning('unknown-technology-unverified', `${at}/requires/${j}`, `${message} (not declared locally; may be built-in)`);
      }
    }
    if (value.skills !== undefined) {
      const items = stringListItems(value.skills, `${at}/skills`, 'combination.skills');
      if (items) for (const [j, ref] of items.entries()) skillRefs.push({at: `${at}/skills/${j}`, id: ref});
    }
  }

  for (const [key, idField, declared, builtins, kind] of [
    ['technologySkills', 'technologyId', declaredTechnologies, builtinTechnologies, 'technology'],
    ['combinationSkills', 'combinationId', declaredCombinations, builtinCombinations, 'combination'],
  ]) {
    if (!Object.hasOwn(map, key)) continue;
    if (!Array.isArray(map[key])) { error('type', `/${key}`, `${key} must be an array`); continue; }
    const seen = new Set();
    for (const [i, value] of map[key].entries()) {
      const at = `${key}/${i}`;
      if (!isRecord(value)) { error('type', at, `${key} entry must be an object`); continue; }
      const id = textValue(value[idField], `${at}/${idField}`, 'text', `${key}.${idField}`);
      if (id !== undefined) {
        if (seen.has(id)) error('unique', `${at}/${idField}`, `Duplicate ${kind} association: ${id}`);
        else seen.add(id);
        if (!declared.has(id) && !builtins?.has(id)) {
          const message = `Unknown ${kind} reference: ${id}`;
          if (builtins) error('unknown-reference', `${at}/${idField}`, message);
          else warning('unknown-reference-unverified', `${at}/${idField}`, `${message} (not declared locally; may be built-in)`);
        }
      }
      if (value.skills === undefined) error('required', `${at}/skills`, `${key}.skills is required`);
      else {
        const items = stringListItems(value.skills, `${at}/skills`, `${key}.skills`);
        if (items) for (const [j, ref] of items.entries()) skillRefs.push({at: `${at}/skills/${j}`, id: ref});
      }
    }
  }

  const reportSkillRef = (at, id) => {
    if (externalIds.has(id)) return;
    if (localSkillIds instanceof Set) {
      if (!localSkillIds.has(id)) issues.push(issue(undeclaredSkillSeverity, 'undeclared-skill', at, `Skill not declared in registry: ${id}`));
    } else {
      warning('undeclared-skill-unverified', at, `Skill reference could not be verified: ${id} (skills-manifest.json unavailable)`);
    }
  };

  for (const {at, id} of skillRefs) reportSkillRef(at, id);

  return issues;
}

export function createMapDocument(registryId) {
  const doc = {$schema: MAP_SCHEMA_URL, schemaVersion: 2, registryId};
  for (const key of CANONICAL_KEY_ORDER) if (!(key in doc)) doc[key] = [];
  return doc;
}

export function serializeMap(map) {
  return JSON.stringify(map, null, 2) + '\n';
}

/** Atomic write via temp file and rename, with the same target safety rules as the generators. */
export async function writeMapFile(root, map) {
  const base = path.resolve(root);
  const target = path.join(base, MAP_FILE);
  const output = serializeMap(map);
  if (Buffer.byteLength(output) > JSON_LIMIT) throw new Error(`skills-map.json would exceed ${JSON_LIMIT} byte limit`);
  let mode = 0o666;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('skills-map.json must be a regular file, not a symlink');
    if (info.nlink > 1) throw new Error('skills-map.json must not be hard-linked');
    if (info.size > JSON_LIMIT) throw new Error(`skills-map.json exceeds ${JSON_LIMIT} byte limit`);
    mode = info.mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path.join(base, `.skills-map.${randomUUID()}.tmp`);
  try { await writeFile(temp, output, {flag: 'wx', mode}); await rename(temp, target); }
  finally { await rm(temp, {force: true}); }
}

// ---------------------------------------------------------------------------
// Idempotent mutations. Each returns {changed, notices, ops} and mutates the
// document in place; the CLI clones before mutating so dry runs are side-effect
// free. Keys absent from the map are created; existing key order is preserved.
// ---------------------------------------------------------------------------

function ensureArray(map, key) { if (!Array.isArray(map[key])) map[key] = []; return map[key]; }

export function addStringListItems(map, key, values, label) {
  const list = ensureArray(map, key);
  const ops = []; const notices = []; let changed = false;
  for (const value of values) {
    if (list.includes(value)) { notices.push(`${label} already present: ${value}`); continue; }
    list.push(value); changed = true; ops.push({action: 'add', path: key, value});
  }
  return {changed, notices, ops};
}

export function removeStringListItems(map, key, values, label) {
  const ops = []; const notices = []; let changed = false;
  const list = map[key];
  if (!Array.isArray(list)) { for (const value of values) notices.push(`${label} not present: ${value}`); return {changed, notices, ops}; }
  for (const value of values) {
    const index = list.indexOf(value);
    if (index === -1) { notices.push(`${label} not present: ${value}`); continue; }
    list.splice(index, 1); changed = true; ops.push({action: 'remove', path: key, value});
  }
  return {changed, notices, ops};
}

export function addExternalSkill(map, entry) {
  const list = ensureArray(map, 'externalSkills');
  if (list.some((item) => isRecord(item) && item.id === entry.id)) {
    return {changed: false, notices: [`external skill already declared: ${entry.id}`], ops: []};
  }
  const record = {id: entry.id, name: entry.name, source: entry.source, skill: entry.skill};
  if (entry.description !== undefined) record.description = entry.description;
  list.push(record);
  return {changed: true, notices: [], ops: [{action: 'add', path: 'externalSkills', value: entry.id}]};
}

export function removeExternalSkills(map, ids) {
  const ops = []; const notices = []; let changed = false;
  const list = map.externalSkills;
  if (!Array.isArray(list)) { for (const id of ids) notices.push(`external skill not declared: ${id}`); return {changed, notices, ops}; }
  for (const id of ids) {
    const index = list.findIndex((item) => isRecord(item) && item.id === id);
    if (index === -1) { notices.push(`external skill not declared: ${id}`); continue; }
    list.splice(index, 1); changed = true; ops.push({action: 'remove', path: 'externalSkills', value: id});
  }
  return {changed, notices, ops};
}

export function addTechnology(map, {id, name, detect, skills = []}) {
  const list = ensureArray(map, 'technologies');
  if (list.some((item) => isRecord(item) && item.id === id)) {
    return {changed: false, notices: [`technology already declared: ${id}`], ops: []};
  }
  const record = {id, name, detect};
  const unique = [...new Set(skills)];
  if (unique.length) record.skills = unique;
  list.push(record);
  return {changed: true, notices: [], ops: [{action: 'add', path: 'technologies', value: id}]};
}

export function removeTechnologies(map, ids) {
  return removeDeclarations(map, 'technologies', ids, 'technology', 'technologySkills', 'technologyId');
}

export function addTechnologySkills(map, technologyId, skills) {
  return addAssociation(map, 'technologySkills', 'technologyId', technologyId, skills);
}

export function removeTechnologySkills(map, technologyId, skills = null) {
  return removeAssociation(map, 'technologySkills', 'technologyId', technologyId, skills, 'technology-skills');
}

export function addCombination(map, {id, name, requires, skills = []}) {
  const list = ensureArray(map, 'combinations');
  if (list.some((item) => isRecord(item) && item.id === id)) {
    return {changed: false, notices: [`combination already declared: ${id}`], ops: []};
  }
  const record = {id, name, requires: [...new Set(requires)]};
  const unique = [...new Set(skills)];
  if (unique.length) record.skills = unique;
  list.push(record);
  return {changed: true, notices: [], ops: [{action: 'add', path: 'combinations', value: id}]};
}

export function removeCombinations(map, ids) {
  return removeDeclarations(map, 'combinations', ids, 'combination', 'combinationSkills', 'combinationId');
}

export function addCombinationSkills(map, combinationId, skills) {
  return addAssociation(map, 'combinationSkills', 'combinationId', combinationId, skills);
}

export function removeCombinationSkills(map, combinationId, skills = null) {
  return removeAssociation(map, 'combinationSkills', 'combinationId', combinationId, skills, 'combination-skills');
}

function removeDeclarations(map, listKey, ids, label, associationKey, idField) {
  const ops = []; const notices = []; let changed = false;
  const list = map[listKey];
  if (!Array.isArray(list)) { for (const id of ids) notices.push(`${label} not declared: ${id}`); return {changed, notices, ops}; }
  for (const id of ids) {
    const index = list.findIndex((item) => isRecord(item) && item.id === id);
    if (index === -1) { notices.push(`${label} not declared: ${id}`); continue; }
    list.splice(index, 1); changed = true; ops.push({action: 'remove', path: listKey, value: id});
    const cascade = removeAssociation(map, associationKey, idField, id, null, `${label}-skills`);
    if (cascade.changed) {
      changed = true; ops.push(...cascade.ops);
      notices.push(`removed ${associationKey} recommendations for ${id}`);
    }
  }
  return {changed, notices, ops};
}

function addAssociation(map, key, idField, id, skills) {
  const list = ensureArray(map, key);
  const unique = [...new Set(skills)];
  const ops = []; const notices = [];
  const index = list.findIndex((item) => isRecord(item) && item[idField] === id);
  if (index === -1) {
    list.push({[idField]: id, skills: unique});
    return {changed: true, notices, ops: [{action: 'add', path: key, value: id}]};
  }
  const entry = list[index];
  if (!Array.isArray(entry.skills)) entry.skills = [];
  let changed = false;
  for (const skill of unique) {
    if (entry.skills.includes(skill)) { notices.push(`${key} already recommends ${skill} for ${id}`); continue; }
    entry.skills.push(skill); changed = true; ops.push({action: 'add', path: key, value: `${id}:${skill}`});
  }
  return {changed, notices, ops};
}

function removeAssociation(map, key, idField, id, skills, label) {
  const ops = []; const notices = []; let changed = false;
  const list = map[key];
  if (!Array.isArray(list)) { notices.push(`${key} entry not found: ${id}`); return {changed, notices, ops}; }
  const index = list.findIndex((item) => isRecord(item) && item[idField] === id);
  if (index === -1) { notices.push(`${key} entry not found: ${id}`); return {changed, notices, ops}; }
  const entry = list[index];
  if (skills === null || skills.length === 0) {
    list.splice(index, 1);
    return {changed: true, notices, ops: [{action: 'remove', path: key, value: id}]};
  }
  const current = Array.isArray(entry.skills) ? entry.skills : [];
  for (const skill of skills) if (!current.includes(skill)) notices.push(`${label} does not recommend ${skill} for ${id}`);
  const kept = current.filter((skill) => !skills.includes(skill));
  if (kept.length !== current.length) {
    entry.skills = kept; changed = true;
    ops.push({action: 'remove', path: key, value: `${id}:${skills.filter((skill) => current.includes(skill)).join(',')}`});
  }
  if (Array.isArray(entry.skills) && entry.skills.length === 0) {
    const at = list.indexOf(entry);
    if (at !== -1) { list.splice(at, 1); notices.push(`removed empty ${key} entry for ${id}`); }
  }
  return {changed, notices, ops};
}

/** Change registryId and remap the old local reference prefix; external IDs are untouched. */
export function setRegistryId(map, newId) {
  const ops = []; const notices = [];
  const old = map.registryId;
  if (old === newId) return {changed: false, notices: [`registryId already ${newId}`], ops};
  const refArrays = [
    ['alwaysRecommend', map.alwaysRecommend],
    ['frontendBonusSkills', map.frontendBonusSkills],
    ...(Array.isArray(map.technologies) ? map.technologies.map((tech, i) => [`technologies/${i}/skills`, tech?.skills]) : []),
    ...(Array.isArray(map.combinations) ? map.combinations.map((combo, i) => [`combinations/${i}/skills`, combo?.skills]) : []),
    ...(Array.isArray(map.technologySkills) ? map.technologySkills.map((a, i) => [`technologySkills/${i}/skills`, a?.skills]) : []),
    ...(Array.isArray(map.combinationSkills) ? map.combinationSkills.map((a, i) => [`combinationSkills/${i}/skills`, a?.skills]) : []),
  ];
  if (typeof old === 'string' && old.length > 0) {
    const oldPrefix = `${old}/`;
    for (const [at, array] of refArrays) {
      if (!Array.isArray(array)) continue;
      for (const [i, ref] of array.entries()) {
        if (typeof ref === 'string' && ref.startsWith(oldPrefix)) {
          array[i] = `${newId}/${ref.slice(oldPrefix.length)}`;
          ops.push({action: 'remap', path: `${at}/${i}`, from: ref, to: array[i]});
        }
      }
    }
  }
  map.registryId = newId;
  ops.push({action: 'set', path: 'registryId', value: newId});
  return {changed: true, notices, ops};
}

export const SECTION_ALIASES = Object.freeze({
  'always-recommend': 'alwaysRecommend',
  'external-skills': 'externalSkills',
  'technologies': 'technologies',
  'technology-skills': 'technologySkills',
  'combinations': 'combinations',
  'combination-skills': 'combinationSkills',
  'frontend-bonus-skills': 'frontendBonusSkills',
  'frontend-packages': 'frontendPackages',
  'frontend-extensions': 'webFrontendExtensions',
  'registry-id': 'registryId',
  'schema-version': 'schemaVersion',
});

const NORMALIZED_SECTIONS = new Set([
  'alwaysRecommend', 'externalSkills', 'technologies', 'technologySkills',
  'combinations', 'combinationSkills', 'frontendBonusSkills', 'frontendPackages', 'webFrontendExtensions',
]);

export function sectionValue(map, alias) {
  if (!isRecord(map)) return undefined;
  // Accept the kebab-case alias or the exact map field name.
  const key = SECTION_ALIASES[alias] ?? (Object.hasOwn(map, alias) ? alias : undefined);
  if (!key) return undefined;
  if (NORMALIZED_SECTIONS.has(key)) return Array.isArray(map[key]) ? map[key] : [];
  return map[key];
}
