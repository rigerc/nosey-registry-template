#!/usr/bin/env node
// Manual, data-only registry identity configuration. Never executes registry content.
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './generate-manifest.mjs';
import {renderReadme} from './generate-readme.mjs';
import {loadSchemas, validateDocuments} from './validate-registry.mjs';

export const MAINTAINER_GUIDE_SENTINEL = '<!-- NOSEY-TEMPLATE-MAINTAINER-GUIDE:v1 -->';
export const MAINTAINER_GUIDE_SHA256 = 'f04c77d2f7bf934675d5f4459d3846fdeb8743abf4b218656fb272e67d1f560b';
export const DOWNSTREAM_GUIDE_SHA256 = '31de20f738298b3bd665e3e2178d412146b620d97aa1f2997dbf2133275d4922';
export const DOWNSTREAM_GUIDE_PATH = '.agents/templates/registry-AGENTS.md';
// Keep fixed-file bounds in sync with Nosey's trusted identity adapter.
const GUIDE_LIMIT = 4 * 1024 * 1024;
const JSON_LIMIT = 4 * 1024 * 1024;
const README_LIMIT = 4 * 1024 * 1024;
const DOCS = ['skills-map.json', 'skills-manifest.json'];
const REF_GROUPS = ['technologies', 'technologySkills', 'combinations', 'combinationSkills'];
const REF_ARRAYS = ['alwaysRecommend', 'frontendBonusSkills'];
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertRegistryId(id) {
  if (typeof id !== 'string') throw new Error('Registry ID must be a valid local owner/repository identity');
  const parts = id.split('/');
  if (parts.length !== 2 || !/^[a-z\d][\w.-]*$/i.test(parts[0]) || !/^[\w.-]+$/.test(parts[1]) ||
      parts.some((part) => part === '.' || part === '..' || part.endsWith('.'))) {
    throw new Error('Registry ID must be a valid local owner/repository identity');
  }
}

async function readRegular(root, name, limit) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Registry root must be a real directory');
  const parts = name.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`${name} has an unsafe parent directory`);
  }
  const filename = path.join(root, name);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) {
    throw new Error(`${name} must be a regular, unlinked file within its size limit`);
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`${name} changed while being opened`);
    }
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  let text;
  // Preserve an initial UTF-8 BOM: JSON.parse must reject it, while README and
  // guide handling must retain and hash every original byte.
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new Error(`${name} is not valid UTF-8`); }
  return {name, filename, bytes, text, stat};
}

function parseJson(file) {
  try { return JSON.parse(file.text); }
  catch (error) { throw new Error(`Invalid JSON in ${file.name}: ${error.message}`); }
}

function localId(id, oldIdentity) {
  if (typeof id !== 'string') throw new Error('Skill reference must be text');
  const prefix = `${oldIdentity}/`;
  if (!id.startsWith(prefix)) return false;
  const relative = id.slice(prefix.length);
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || /[\\\0-\x1f\x7f<>:"|?*]/u.test(part))) {
    throw new Error(`Unsafe local skill ID: ${id}`);
  }
  return true;
}

function rewriteReferences(map, declared, externals, oldIdentity, requested) {
  const rewrite = (id) => {
    if (typeof id !== 'string') throw new Error('Skill reference must be text');
    if (externals.has(id)) return id;
    if (declared.has(id)) return `${requested}${id.slice(oldIdentity.length)}`;
    if (localId(id, oldIdentity)) throw new Error(`Undeclared local skill reference: ${id}`);
    throw new Error(`Undeclared skill reference: ${id}`);
  };
  for (const key of REF_ARRAYS) {
    const values = map[key];
    if (values === undefined || values === null) continue;
    if (!Array.isArray(values)) throw new Error(`${key} must be an array or null`);
    map[key] = values.map(rewrite);
  }
  for (const key of REF_GROUPS) {
    const groups = map[key];
    if (groups === undefined || groups === null) continue;
    if (!Array.isArray(groups)) throw new Error(`${key} must be an array or null`);
    for (const group of groups) {
      if (!obj(group)) throw new Error(`${key} entries must be objects`);
      if (group.skills === undefined || group.skills === null) continue;
      if (!Array.isArray(group.skills)) throw new Error(`${key}[].skills must be an array or null`);
      group.skills = group.skills.map(rewrite);
    }
  }
}

function checkDeclaredSkills(manifest, map) {
  if (!obj(map) || !obj(manifest)) throw new Error('skills-map.json and skills-manifest.json must be JSON objects');
  assertRegistryId(map.registryId);
  if (manifest.registryId !== map.registryId) throw new Error('skills-map.json and skills-manifest.json registryId do not match');
  if (![1, 2].includes(map.schemaVersion) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills)) {
    throw new Error('Registry documents have unsupported or malformed schema versions');
  }
  const seen = new Set();
  for (const skill of manifest.skills) {
    if (!obj(skill) || typeof skill.id !== 'string' || typeof skill.path !== 'string') throw new Error('Manifest skills require string id and path fields');
    if (seen.has(skill.id)) throw new Error(`Duplicate local skill ID: ${skill.id}`);
    seen.add(skill.id);
    if (!localId(skill.id, map.registryId)) throw new Error(`Manifest skill is not declared under registry identity: ${skill.id}`);
    const relative = skill.id.slice(map.registryId.length + 1);
    const expected = `skills/${relative}/SKILL.md`;
    if (skill.path !== expected || skill.path.includes('\\') || skill.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Skill ID and safe path do not match: ${skill.id} (${skill.path})`);
    }
  }
  const externalSkills = map.externalSkills ?? [];
  if (!Array.isArray(externalSkills)) throw new Error('externalSkills must be an array or null');
  const external = new Set();
  for (const item of externalSkills) {
    if (!obj(item) || typeof item.id !== 'string' || external.has(item.id)) throw new Error('externalSkills entries require unique string IDs');
    external.add(item.id);
  }
  for (const id of external) if (seen.has(id)) throw new Error(`Local/external skill ID collision: ${id}`);
  return {declared: seen, external};
}

async function readGuide(root, inputs) {
  let guide;
  try { guide = await readRegular(root, 'AGENTS.md', GUIDE_LIMIT); }
  catch (error) { if (error.code === 'ENOENT') return {kind: 'absent'}; throw error; }
  const {text: content} = guide;
  inputs.set('AGENTS.md', guide);
  if (!content.includes(MAINTAINER_GUIDE_SENTINEL)) {
    if (content.includes('# Registry template agent guide')) throw new Error('AGENTS.md looks like an unrecognized maintainer guide; review it manually before configuring');
    return {kind: 'user'};
  }
  if (!content.startsWith(`${MAINTAINER_GUIDE_SENTINEL}\n`) || digest(guide.bytes) !== MAINTAINER_GUIDE_SHA256) {
    throw new Error('AGENTS.md contains a modified or conflicting maintainer-guide sentinel; review it manually before configuring');
  }
  return {kind: 'maintainer'};
}

async function canonicalDownstreamGuide(root) {
  const guide = await readRegular(root, DOWNSTREAM_GUIDE_PATH, GUIDE_LIMIT);
  if (digest(guide.bytes) !== DOWNSTREAM_GUIDE_SHA256) throw new Error('Canonical downstream guide failed its integrity check');
  return guide.text;
}

function assertOutputBytes(name, bytes) {
  const limit = name === 'README.md' ? README_LIMIT : name === 'AGENTS.md' ? GUIDE_LIMIT : JSON_LIMIT;
  if (bytes.byteLength > limit) throw new Error(`${name} exceeds its output size limit`);
  if (name.endsWith('.json')) {
    try { JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new Error(`Generated ${name} is invalid JSON: ${error.message}`); }
  }
}

function orderedManifest(manifest) {
  const entries = [];
  for (const key of ['$schema', 'schemaVersion', 'registryId', 'skills']) {
    if (Object.hasOwn(manifest, key)) entries.push([key, manifest[key]]);
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (!['$schema', 'schemaVersion', 'registryId', 'skills'].includes(key)) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

async function verifyManifestSkillFiles(root, manifest) {
  for (const skill of manifest.skills) {
    const parts = skill.path.split('/');
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current);
      const last = index === parts.length - 1;
      if (info.isSymbolicLink() || (last ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
        throw new Error(`Skill path contains an unsafe file or directory: ${skill.path}`);
      }
    }
  }
}

async function recheckInputs(inputs) {
  for (const input of inputs.values()) {
    let current;
    try { current = await readRegular(path.dirname(input.filename), path.basename(input.filename), input.name === 'README.md' ? README_LIMIT : input.name === 'AGENTS.md' ? GUIDE_LIMIT : JSON_LIMIT); }
    catch (error) { throw new Error(`${input.name} changed to an unsafe file before staging: ${error.message}`); }
    if (current.stat.dev !== input.stat.dev || current.stat.ino !== input.stat.ino || !current.bytes.equals(input.bytes)) {
      throw new Error(`${input.name} changed during configuration`);
    }
  }
}

async function commitFiles(root, outputs, inputs, hooks = {}) {
  await recheckInputs(inputs);
  const staged = [];
  const replace = hooks.rename ?? rename;
  const restore = hooks.restore ?? rename;
  try {
    for (const name of outputs.keys()) {
      if (inputs.has(name)) continue;
      try { await lstat(path.join(root, name)); throw new Error(`${name} appeared during configuration`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const [name, bytes] of outputs) {
      const original = inputs.get(name);
      if (original?.bytes.equals(bytes)) continue;
      const filename = path.join(root, name);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const mode = original ? original.stat.mode & 0o777 : 0o644;
      const item = {name, filename, temporary, original, backup: undefined, installed: false, preserveBackup: false};
      staged.push(item);
      await (hooks.writeFile ?? writeFile)(temporary, bytes, {flag: 'wx', mode});
      if (original) {
        item.backup = `${filename}.${randomUUID()}.bak`;
        await writeFile(item.backup, original.bytes, {flag: 'wx', mode: original.stat.mode & 0o777});
      }
    }
    await recheckInputs(inputs);
    let renamed = 0;
    for (const item of staged) {
      if (hooks.beforeRename) await hooks.beforeRename(item.name, renamed);
      if (!item.original) {
        try { await lstat(item.filename); throw new Error(`${item.name} appeared before replacement`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await replace(item.temporary, item.filename);
      item.temporary = undefined;
      item.installed = true;
      renamed++;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of staged.slice().reverse()) {
      if (!item.installed) continue;
      try {
        if (item.original) {
          await restore(item.backup, item.filename);
          item.backup = undefined;
        } else await rm(item.filename);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.name}: ${rollbackError.message}; original preserved at ${item.backup}`);
        item.preserveBackup = true;
      }
    }
    if (rollbackErrors.length) throw new Error(`Configuration failed (${error.message}); rollback failed: ${rollbackErrors.join('; ')}`);
    throw new Error(`Configuration failed and changed inputs were restored: ${error.message}`);
  } finally {
    await Promise.all(staged.flatMap((item) => [
      item.temporary ? rm(item.temporary, {force: true}) : Promise.resolve(),
      item.backup && !item.preserveBackup ? rm(item.backup, {force: true}) : Promise.resolve(),
    ]));
  }
  return staged.filter((item) => item.temporary === undefined).map((item) => item.name);
}

/** Configure a registry using trusted module APIs; options are explicit test/CI seams. */
export async function configureRegistry(root, requested, options = {}) {
  assertRegistryId(requested);
  const base = path.resolve(root);
  const inputs = new Map();
  for (const name of DOCS) inputs.set(name, await readRegular(base, name, JSON_LIMIT));
  inputs.set('README.md', await readRegular(base, 'README.md', README_LIMIT));
  const [mapOriginal, manifestOriginal] = DOCS.map((name) => parseJson(inputs.get(name)));
  const {declared, external} = checkDeclaredSkills(manifestOriginal, mapOriginal);
  const guideStatus = await readGuide(base, inputs);
  const schemas = options.schemas ?? await loadSchemas({schemasDir: options.schemasDir, request: options.request});
  await validateDocuments({root: base, manifest: manifestOriginal, map: mapOriginal, schemas});
  await verifyManifestSkillFiles(base, manifestOriginal);

  const map = structuredClone(mapOriginal);
  const manifestSeed = structuredClone(manifestOriginal);
  const oldIdentity = map.registryId;
  rewriteReferences(map, declared, external, oldIdentity, requested);
  for (const skill of manifestSeed.skills) skill.id = `${requested}${skill.id.slice(oldIdentity.length)}`;
  map.registryId = requested;

  // Build generated output entirely in memory. Unknown fields and annotations flow
  // through buildManifest from the original model.
  const generatedManifest = await buildManifest(base, map, manifestSeed);
  const manifest = orderedManifest(generatedManifest);
  const readme = renderReadme(inputs.get('README.md').text, manifest, map);
  const outputs = new Map([
    ['skills-map.json', Buffer.from(`${JSON.stringify(map, null, 2)}\n`)],
    ['skills-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['README.md', Buffer.from(readme)],
  ]);
  if (guideStatus.kind === 'maintainer') outputs.set('AGENTS.md', Buffer.from(await canonicalDownstreamGuide(base)));

  for (const [name, bytes] of outputs) assertOutputBytes(name, bytes);
  await validateDocuments({root: base, manifest, map, schemas});
  await verifyManifestSkillFiles(base, manifest);
  const committed = await commitFiles(base, outputs, inputs, options.fileOps);
  return {registryId: requested, changed: committed, guidePolicy: {
    sentinel: MAINTAINER_GUIDE_SENTINEL,
    maintainerGuideSha256: MAINTAINER_GUIDE_SHA256,
    downstreamGuideSha256: DOWNSTREAM_GUIDE_SHA256,
    downstreamGuidePath: DOWNSTREAM_GUIDE_PATH,
  }};
}

async function main(argv) {
  let root = process.cwd();
  const positional = [];
  let schemasDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--schemas') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--root') root = argv[++i]; else schemasDir = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('Usage: node scripts/configure-registry.mjs owner/repository [--root dir] [--schemas dir]');
  const result = await configureRegistry(path.resolve(root), positional[0], {schemasDir});
  console.log(result.changed.length ? `Configured registry ${result.registryId}.` : `Registry ${result.registryId} is already configured.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
