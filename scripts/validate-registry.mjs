#!/usr/bin/env node
// Read-only validation against the latest Nosey schemas and parser contract.
import {constants as fsConstants} from 'node:fs';
import {lstat, open, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {assertSchemaSupported, validateSchema} from './lib/schema-validator.mjs';

const SCHEMA_URLS = Object.freeze({
  manifest: 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json',
  map: 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json',
});
const MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function fail(message) { throw new Error(message); }
function record(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object`);
  return value;
}
function strings(value, where) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) fail(`${where} must be an array of nonempty strings`);
  return value;
}
function text(value, where) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} must be a nonempty string`);
  return value;
}
function unique(values, where) {
  if (new Set(values).size !== values.length) fail(`Duplicate ${where}`);
}
function parseJson(textValue, label) {
  try { return JSON.parse(textValue); }
  catch (error) { fail(`Invalid JSON in ${label}: ${error.message}`); }
}

async function readFixtureSchema(file) {
  let before;
  try { before = await lstat(file); } catch (error) { fail(`Cannot read schema fixture ${file}: ${error.message}`); }
  if (before.isSymbolicLink() || !before.isFile()) fail(`Schema fixture must be a regular file: ${file}`);
  if (before.size > MAX_SCHEMA_BYTES) fail(`Schema fixture exceeds ${MAX_SCHEMA_BYTES} bytes: ${file}`);
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail(`Schema fixture changed while opening: ${file}`);
    if (opened.size > MAX_SCHEMA_BYTES) fail(`Schema fixture exceeds ${MAX_SCHEMA_BYTES} bytes: ${file}`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_SCHEMA_BYTES + 1 - total));
      const {bytesRead} = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SCHEMA_BYTES) fail(`Schema fixture exceeds ${MAX_SCHEMA_BYTES} bytes: ${file}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== total || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail(`Schema fixture changed while reading: ${file}`);
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    if (error instanceof TypeError || error.message.startsWith('Schema fixture')) throw error;
    fail(`Cannot safely read schema fixture ${file}: ${error.message}`);
  } finally { await handle?.close(); }
}

async function readBounded(response, url) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SCHEMA_BYTES)) {
    fail(`Schema response exceeds ${MAX_SCHEMA_BYTES} bytes: ${url}`);
  }
  if (!response.body) fail(`Empty schema response body: ${url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SCHEMA_BYTES) {
        await reader.cancel();
        fail(`Schema response exceeds ${MAX_SCHEMA_BYTES} bytes: ${url}`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchSchema(url, request = fetch) {
  let response;
  try {
    response = await request(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) fail(`Redirect refused (HTTP ${response.status}): ${url}`);
    if (!response.ok) fail(`HTTP ${response.status}: ${url}`);
    return parseJson(await readBounded(response, url), url);
  } catch (error) {
    if (error.message.includes(url)) throw error;
    fail(`Cannot load Nosey schema ${url}: ${error.message}`);
  }
}

/** Fetch both hard-coded Nosey schemas freshly. request is injectable for tests. */
export async function loadSchemas({schemasDir, request = fetch} = {}) {
  let schemas;
  if (schemasDir !== undefined) {
    const dir = path.resolve(schemasDir);
    schemas = {
      manifest: parseJson(await readFixtureSchema(path.join(dir, 'skills-manifest.schema.json')), path.join(dir, 'skills-manifest.schema.json')),
      map: parseJson(await readFixtureSchema(path.join(dir, 'skills-map.schema.json')), path.join(dir, 'skills-map.schema.json')),
    };
  } else {
    const [manifest, map] = await Promise.all([
      fetchSchema(SCHEMA_URLS.manifest, request), fetchSchema(SCHEMA_URLS.map, request),
    ]);
    schemas = {manifest, map};
  }
  for (const [name, schema] of Object.entries(schemas)) {
    try {
      record(schema, `${name} schema`);
      assertSchemaSupported(schema);
    } catch (error) { fail(`Invalid Nosey ${name} schema (${SCHEMA_URLS[name]}): ${error.message}`); }
  }
  return schemas;
}

function schemaCheck(schema, value, name) {
  const result = validateSchema(schema, value);
  if (!result.valid) fail(`${name}: ${result.errors.map((e) => `${e.path || '/'} [${e.keyword}] ${e.message}`).join('; ')}`);
}

function safeManifestPath(value) {
  const p = text(value, 'skill.path');
  if (p.includes('\\') || p.includes('\0') || path.posix.isAbsolute(p) || path.posix.normalize(p) !== p || !p.startsWith('skills/') || !p.endsWith('/SKILL.md') || p.split('/').some((part) => part === '.' || part === '..' || !part)) fail(`Unsafe skill path: ${p}`);
  return p;
}
async function verifySkillFile(root, relative) {
  const segments = relative.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); } catch (error) { fail(`Skill path does not exist: ${relative} (${error.message})`); }
    if (info.isSymbolicLink()) fail(`Skill path contains a symlink: ${relative}`);
    const isFile = index === segments.length - 1;
    if (isFile ? !info.isFile() : !info.isDirectory()) fail(`Skill path has an invalid component: ${relative}`);
  }
  const resolved = await realpath(path.dirname(path.join(root, relative)));
  const rootReal = await realpath(root);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) fail(`Skill path escapes registry root: ${relative}`);
}

function optionalArray(map, key) {
  const value = map[key];
  return value == null ? [] : value;
}
function regexRule(rule, where) {
  record(rule, where);
  const source = rule.source;
  const flags = rule.flags === undefined ? '' : rule.flags;
  if (typeof source !== 'string' || typeof flags !== 'string') fail(`${where} requires a string source and optional string flags`);
  if (source.length > 512) fail(`${where}.source exceeds 512 UTF-16 code units`);
  if (/[gy]/.test(flags)) fail(`${where} uses unsupported stateful regex flags`);
  try { new RegExp(source, flags); } catch (error) { fail(`${where} is invalid: ${error.message}`); }
}
function validateDetect(value, where) {
  const detect = record(value, where);
  const allowedStrings = ['packages','pythonPackages','composerPackages','goModules','rustCrates','elixirPackages','configFiles','fileExtensions','gems'];
  const allowed = new Set([...allowedStrings, 'packagePatterns','configFileContent','mcpServers']);
  for (const key of Object.keys(detect)) if (!allowed.has(key)) fail(`Unknown detection field: ${key}`);
  for (const key of allowedStrings) if (detect[key] !== undefined) strings(detect[key], `${where}.${key}`);
  if (detect.packagePatterns !== undefined) {
    if (!Array.isArray(detect.packagePatterns)) fail(`${where}.packagePatterns must be an array`);
    detect.packagePatterns.forEach((r, i) => regexRule(r, `${where}.packagePatterns[${i}]`));
  }
  if (detect.configFileContent !== undefined) {
    const blocks = Array.isArray(detect.configFileContent) ? detect.configFileContent : [detect.configFileContent];
    for (const [i, blockValue] of blocks.entries()) {
      const block = record(blockValue, `${where}.configFileContent[${i}]`);
      if (!Array.isArray(block.patterns) || block.patterns.length < 1 || block.patterns.length > 64) fail(`${where}.configFileContent.patterns must contain 1 to 64 entries`);
      block.patterns.forEach((pattern, j) => { if (typeof pattern !== 'string') regexRule(pattern, `${where}.configFileContent.patterns[${j}]`); });
      for (const k of ['files','sourceExtensions']) if (block[k] !== undefined) strings(block[k], `${where}.configFileContent.${k}`);
      for (const k of ['scanGradleLayout','scanDotNetLayout','allPatterns','maskStrings']) if (block[k] !== undefined && typeof block[k] !== 'boolean') fail(`${where}.configFileContent.${k} must be boolean`);
      if (block.stripComments !== undefined && !['code','hash','xml'].includes(block.stripComments)) fail(`${where}.configFileContent.stripComments is invalid`);
    }
  }
  if (detect.mcpServers !== undefined) {
    if (!Array.isArray(detect.mcpServers) || detect.mcpServers.length > 64) fail(`${where}.mcpServers must be an array with at most 64 matchers`);
    for (const [i, matcherValue] of detect.mcpServers.entries()) {
      const m = record(matcherValue, `${where}.mcpServers[${i}]`);
      const keys = ['packages','pythonPackages','endpoints','serverNames','configFiles'];
      for (const key of Object.keys(m)) if (!keys.includes(key)) fail(`Unknown mcpServers matcher field: ${key}`);
      for (const key of keys) if (m[key] !== undefined) {
        const items = strings(m[key], `mcpServers.${key}`);
        if (items.length < 1 || items.length > 64) fail(`mcpServers.${key} requires 1 to 64 entries`);
      }
      for (const file of m.configFiles ?? []) if (file.includes('\\') || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file.split('/').some((x) => x === '.' || x === '..') || !['.mcp.json','.cursor/mcp.json','.vscode/mcp.json','.codex/config.toml'].some((x) => file === x || file.endsWith('/' + x))) fail(`Invalid mcpServers.configFiles path: ${file}`);
      if (!['packages','pythonPackages','endpoints','serverNames'].some((key) => m[key]?.length)) fail('mcpServers matcher requires an identity');
    }
  }
}
function requireDeclaredRefs(map, declared) {
  const refs = [
    ...optionalArray(map, 'alwaysRecommend'), ...optionalArray(map, 'frontendBonusSkills'),
    ...(map.technologies ?? []).flatMap((x) => x.skills ?? []),
    ...(map.combinations ?? []).flatMap((x) => x.skills ?? []),
    ...(map.technologySkills ?? []).flatMap((x) => x.skills ?? []),
    ...(map.combinationSkills ?? []).flatMap((x) => x.skills ?? []),
  ];
  for (const id of refs) if (!declared.has(id)) fail(`Skill not declared in registry: ${id}`);
}

/** Validate in-memory documents and referenced files without writing. */
export async function validateDocuments({root = process.cwd(), manifest, map, schemas}) {
  record(manifest, 'skills-manifest.json'); record(map, 'skills-map.json');
  schemaCheck(schemas.manifest, manifest, 'skills-manifest.json');
  schemaCheck(schemas.map, map, 'skills-map.json');
  text(manifest.registryId, 'skills-manifest.json.registryId');
  text(map.registryId, 'skills-map.json.registryId');
  if (manifest.schemaVersion !== 1) fail('Unsupported manifest schemaVersion (expected 1)');
  if (map.schemaVersion !== 1 && map.schemaVersion !== 2) fail('Unsupported skills-map.json schemaVersion (expected 1 or 2)');
  if (manifest.registryId !== map.registryId) fail('skills-manifest.json and skills-map.json registryId do not match');
  if (map.schemaVersion === 1 && Object.hasOwn(map, 'externalSkills')) fail('externalSkills requires skills-map.json schemaVersion 2');
  const entries = manifest.skills;
  if (!Array.isArray(entries) || entries.length > 20_000) fail('skills must be an array of at most 20000 entries');
  const ids = []; const paths = [];
  for (const [index, entryValue] of entries.entries()) {
    const entry = record(entryValue, `skills[${index}]`);
    const id = text(entry.id, `skills[${index}].id`);
    text(entry.name, `skills[${index}].name`);
    if (entry.description !== undefined) text(entry.description, `skills[${index}].description`);
    const p = safeManifestPath(entry.path);
    const skillDir = path.posix.dirname(p).slice('skills/'.length);
    if (!skillDir || id !== `${manifest.registryId}/${skillDir}`) fail(`Skill ID and path do not match: ${id} (${p})`);
    ids.push(id); paths.push(p); await verifySkillFile(path.resolve(root), p);
  }
  unique(ids, 'skill IDs'); unique(paths, 'skill paths');
  const externals = optionalArray(map, 'externalSkills');
  if (!Array.isArray(externals) || externals.length > 20_000) fail('externalSkills must be an array of at most 20000 entries');
  const extIds = [];
  for (const [i, value] of externals.entries()) {
    const e = record(value, `externalSkills[${i}]`);
    const id = text(e.id, 'external skill.id');
    if (!/^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(id) || id.split('/').some((x) => x === '.' || x === '..')) fail(`Invalid external skill ID: ${id}`);
    text(e.name, 'external skill.name'); text(e.skill, 'external skill.skill');
    if (!/^[A-Za-z0-9_.@-]+$/.test(e.skill) || e.skill === '.' || e.skill === '..') fail(`Invalid external skill name: ${e.skill}`);
    text(e.source, 'external skill.source');
    const sourceRE = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*?)(?:\.git)?\/?$/i;
    const source = sourceRE.exec(e.source);
    if (!source) fail('External skill source must be a GitHub owner/repository or GitHub HTTPS/SSH URL');
    const [owner, repo] = source[1].split('/');
    if (!owner || !repo || repo === '..' || owner.endsWith('.') || repo.endsWith('.')) fail(`Invalid external skill source: ${e.source}`);
    for (const key of Object.keys(e)) if (!['id','name','description','source','skill'].includes(key)) fail(`Unknown external skill field: ${key}`);
    if (e.description !== undefined) text(e.description, 'external skill.description');
    extIds.push(id);
  }
  unique(extIds, 'external skill IDs');
  const localIds = new Set(ids);
  for (const id of extIds) if (localIds.has(id)) fail(`Local/external skill ID collision: ${id}`);
  const declared = new Set([...ids, ...extIds]);
  const techBuiltins = schemas.map['x-builtInTechnologies'];
  const comboBuiltins = schemas.map['x-builtInCombinations'];
  const technologies = optionalArray(map, 'technologies'); const combinations = optionalArray(map, 'combinations');
  if (!Array.isArray(technologies) || !Array.isArray(combinations)) fail('technologies and combinations must be arrays');
  const techIds = technologies.map((x, i) => { record(x, `technologies[${i}]`); text(x.id, 'technology.id'); text(x.name, 'technology.name'); validateDetect(x.detect, `technologies[${i}].detect`); strings(x.skills ?? [], 'technology.skills'); return x.id; });
  const comboIds = combinations.map((x, i) => { record(x, `combinations[${i}]`); text(x.id, 'combination.id'); text(x.name, 'combination.name'); strings(x.requires, 'combination.requires'); strings(x.skills ?? [], 'combination.skills'); return x.id; });
  unique(techIds, 'technology IDs'); unique(comboIds, 'combination IDs');
  if (techBuiltins !== undefined && (!Array.isArray(techBuiltins) || techBuiltins.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || !x.id))) fail('Nosey map schema has an invalid x-builtInTechnologies inventory');
  const techBuiltinIds = Array.isArray(techBuiltins) ? techBuiltins.map((x) => x.id) : [];
  unique(techBuiltinIds, 'built-in technology IDs');
  const techLookupRequired = technologies.length > 0 || optionalArray(map, 'technologySkills').length > 0;
  if (techLookupRequired && techBuiltins === undefined) fail('Nosey map schema does not publish x-builtInTechnologies; cannot validate built-in technology references');
  if (techIds.some((id) => techBuiltinIds.includes(id))) fail('Technology ID conflicts with a built-in technology');
  const comboLookupRequired = combinations.length > 0 || optionalArray(map, 'combinationSkills').length > 0;
  if (comboLookupRequired && !Array.isArray(comboBuiltins)) fail('Nosey map schema does not publish x-builtInCombinations; cannot validate built-in combination references');
  if (comboBuiltins !== undefined && (!Array.isArray(comboBuiltins) || comboBuiltins.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || !x.id))) fail('Nosey map schema has an invalid x-builtInCombinations inventory');
  const comboBuiltinIds = Array.isArray(comboBuiltins) ? comboBuiltins.map((x) => x.id) : [];
  unique(comboBuiltinIds, 'built-in combination IDs');
  if (comboIds.some((id) => comboBuiltinIds.includes(id))) fail('Combination ID conflicts with a built-in combination');
  const allTech = new Set([...techIds, ...techBuiltinIds]); const allCombos = new Set([...comboIds, ...comboBuiltinIds]);
  for (const [i, combo] of combinations.entries()) for (const id of combo.requires) if (!allTech.has(id)) fail(`Unknown technology in combination ${combo.id}: ${id}`);
  for (const [key, kind, known] of [['technologySkills','technology',allTech],['combinationSkills','combination',allCombos]]) {
    const associations = optionalArray(map, key);
    if (!Array.isArray(associations)) fail(`${key} must be an array`);
    const associationIds = [];
    for (const [i, associationValue] of associations.entries()) {
      const a = record(associationValue, `${key}[${i}]`);
      const id = text(kind === 'technology' ? a.technologyId : a.combinationId, `${key} association ID`);
      if (!known.has(id)) fail(`Unknown ${kind} reference: ${id}`);
      associationIds.push(id); strings(a.skills, `${key}.skills`);
    }
    unique(associationIds, `${kind} associations`);
  }
  for (const tech of technologies) strings(tech.skills ?? [], 'technology.skills');
  for (const combo of combinations) strings(combo.skills ?? [], 'combination.skills');
  for (const field of ['alwaysRecommend','frontendBonusSkills','frontendPackages','webFrontendExtensions']) strings(optionalArray(map, field), field);
  requireDeclaredRefs(map, declared);
  return {valid: true};
}

async function readDocument(root, name) {
  const full = path.join(root, name);
  const info = await lstat(full).catch((error) => fail(`Cannot read ${name}: ${error.message}`));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) fail(`Invalid registry document: ${name}`);
  return parseJson(await readFile(full, 'utf8'), name);
}
/** Load on-disk manifest/map and validate; registry.json is never inspected. */
export async function validateRegistry({root = process.cwd(), schemasDir, request} = {}) {
  const schemas = await loadSchemas({schemasDir, request});
  const [manifest, map] = await Promise.all([readDocument(root, 'skills-manifest.json'), readDocument(root, 'skills-map.json')]);
  return validateDocuments({root, manifest, map, schemas});
}

function parseArgs(argv) {
  const options = {root: process.cwd()};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--root','--schemas'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('Usage: node scripts/validate-registry.mjs [--root <dir>] [--schemas <dir>]');
    const value = argv[++i];
    if (flag === '--root') options.root = value; else options.schemasDir = value;
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await validateRegistry(parseArgs(process.argv.slice(2))); console.log('Registry documents and skill references are valid.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
