#!/usr/bin/env node
// Self-contained, reviewed template-file updates. No upstream code is executed.
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const origin = 'rigerc/nosey-registry-template';
const stateFile = '.template/state.json';
const MAX_BYTES = 4 * 1024 * 1024;
const single = new Set([
  '.agnix.toml', '.editorconfig', '.gitignore', '.templatesyncignore',
  '.github/pull_request_template.md', 'CONTRIBUTING.md',
  'Makefile', 'NOTICE.md', 'NOSEY_NOTICES.md', 'NOSEY_LICENSE_APACHE_2_0', 'SECURITY.md',
]);
export function managed(file) {
  return typeof file === 'string' && !file.startsWith('/') && !file.includes('\\') &&
    !file.includes('\0') && file.split('/').every((part) => part && part !== '.' && part !== '..') &&
    (single.has(file) || file.startsWith('scripts/') || file.startsWith('.github/workflows/'));
}
function exec(args, cwd, tolerateFailure = false) {
  const run = spawnSync('git', args, {cwd, encoding: 'buffer', maxBuffer: MAX_BYTES, timeout: 120000});
  if (run.error) throw run.error;
  if (run.status !== 0) {
    if (tolerateFailure) return null;
    throw new Error('Git operation failed: ' + (run.stderr?.toString('utf8') ?? '').trim());
  }
  return run.stdout;
}
const git = (root, ...args) => exec(['-C', root, ...args], process.cwd());
const same = (a, b) => a === b || (a !== null && b !== null && a.equals(b));
function revisionFiles(root, rev) {
  const result = new Map();
  for (const entry of git(root, 'ls-tree', '-rz', rev).toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    const name = entry.slice(tab + 1);
    if (!entry || !managed(name)) continue;
    const header = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(entry.slice(0, tab));
    if (!header) throw new Error('Unsafe upstream managed file: ' + name);
    result.set(name, header[2]);
  }
  return result;
}
async function local(root, filename) {
  const pieces = filename.split('/');
  let parent = root;
  for (const piece of pieces.slice(0, -1)) {
    parent = path.join(parent, piece);
    const stat = await fs.lstat(parent).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory: ' + parent);
  }
  const file = path.join(root, filename);
  const stat = await fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) {
    throw new Error('Unsafe managed file: ' + filename);
  }
  return fs.readFile(file);
}
async function merge(base, ours, theirs) {
  if (same(ours, theirs) || same(base, theirs)) return {value: ours};
  if (same(base, ours)) return {value: theirs};
  if (base === null || ours === null || theirs === null) return {conflict: true};
  if ([base, ours, theirs].some((b) => b.includes(0))) return {conflict: true};
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-merge-'));
  try {
    const files = ['local', 'base', 'upstream'].map((name) => path.join(dir, name));
    await Promise.all(files.map((name, i) => fs.writeFile(name, [ours, base, theirs][i])));
    const result = exec(['merge-file', '-p', ...files], dir, true);
    if (result === null || result.length > MAX_BYTES) return {conflict: true};
    return {value: result};
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}
async function put(root, filename, value) {
  const components = filename.split('/');
  let parent = root;
  for (const piece of components.slice(0, -1)) {
    parent = path.join(parent, piece);
    await fs.mkdir(parent, {recursive: true});
    const stat = await fs.lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory: ' + parent);
  }
  const location = path.join(root, filename);
  if (value === null) {
    await fs.rm(location, {force: true});
  } else {
    const tmp = location + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, value, {flag: 'wx'});
      await fs.rename(tmp, location);
    } finally {
      await fs.rm(tmp, {force: true});
    }
  }
}

/** Record exact upstream file versions without a self-referential commit ID. Template maintainers only. */
export async function recordTemplateState(root = process.cwd(), check = false) {
  const directory = await fs.realpath(root);
  const names = new Set(single);
  async function walk(relative) {
    const stat = await fs.lstat(path.join(directory, relative)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory: ' + relative);
    for (const entry of await fs.readdir(path.join(directory, relative), {withFileTypes: true})) {
      const name = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Unsafe managed file: ' + name);
      if (entry.isDirectory()) await walk(name);
      else if (managed(name)) names.add(name);
    }
  }
  for (const relative of ['scripts', '.github/workflows']) await walk(relative);
  const files = [];
  for (const name of [...names].sort()) {
    const bytes = await local(directory, name);
    if (bytes === null) continue;
    const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    files.push([name, blob]);
  }
  const state = {schemaVersion: 2, source: origin, files: Object.fromEntries(files)};
  const output = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  if (check) {
    if (!same(await local(directory, stateFile), output)) {
      throw new Error('Template baseline is stale; run node scripts/template-state.mjs in the upstream template.');
    }
  } else await put(directory, stateFile, output);
  return state;
}

export async function update({root = process.cwd(), source = 'https://github.com/' + origin + '.git', ref = 'main'} = {}) {
  const directory = await fs.realpath(root);
  if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new Error('Invalid upstream ref');
  }
  const stateInfo = await fs.lstat(path.join(directory, stateFile));
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > MAX_BYTES) throw new Error('Unsafe template state');
  const state = JSON.parse(await fs.readFile(path.join(directory, stateFile), 'utf8'));
  const revision = typeof state.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(state.sourceRevision);
  const fileVersions = state.files && typeof state.files === 'object' && !Array.isArray(state.files) &&
    Object.entries(state.files).every(([name, blob]) => managed(name) && typeof blob === 'string' && /^[a-f0-9]{40}$/.test(blob));
  if (state.source !== origin ||
    !(state.schemaVersion === 1 && revision || state.schemaVersion === 2 && fileVersions)) {
    throw new Error('Invalid template provenance');
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'template-sync-'));
  const upstream = path.join(temp, 'upstream');
  try {
    // A bare clone retains every branch as a local ref, including non-default --ref targets.
    exec(['clone', '--quiet', '--bare', '--', source, upstream], directory);
    const target = git(upstream, 'rev-parse', ref + '^{commit}').toString('utf8').trim();
    if (state.schemaVersion === 2 && target === state.sourceRevision) return {revision: target, updated: []};
    const baseFiles = state.schemaVersion === 2
      ? new Map(Object.entries(state.files))
      : revisionFiles(upstream, state.sourceRevision);
    const targetFiles = revisionFiles(upstream, target);
    const candidates = [...new Set([...baseFiles.keys(), ...targetFiles.keys()])].sort();
    const changes = [], conflicts = [];
    for (const name of candidates) {
      const base = baseFiles.has(name) ? git(upstream, 'cat-file', 'blob', baseFiles.get(name)) : null;
      const theirs = targetFiles.has(name) ? git(upstream, 'cat-file', 'blob', targetFiles.get(name)) : null;
      const ours = await local(directory, name);
      const result = await merge(base, ours, theirs);
      if (result.conflict) conflicts.push(name);
      else if (!same(ours, result.value)) changes.push({name, value: result.value});
    }
    if (conflicts.length) throw new Error('Template merge conflicts (no files updated): ' + conflicts.join(', '));
    for (const change of changes) await put(directory, change.name, change.value);
    await put(directory, stateFile, Buffer.from(JSON.stringify({
      schemaVersion: 2, source: origin, sourceRevision: target, files: Object.fromEntries(targetFiles),
    }, null, 2) + '\n'));
    return {revision: target, updated: changes.map((change) => change.name)};
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (!(args.length === 0 || (args.length === 2 && args[0] === '--ref'))) {
      throw new Error('Usage: node scripts/template-update.mjs [--ref branch-or-tag]');
    }
    const result = await update({ref: args[1] ?? 'main'});
    console.log('Template revision: ' + result.revision + ', managed files changed: ' + result.updated.length);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
