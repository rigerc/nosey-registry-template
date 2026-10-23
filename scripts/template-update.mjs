#!/usr/bin/env node
// Self-contained, reviewed template-file updates. No upstream code is executed.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
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
const probe = (root, ...args) => exec(['-C', root, ...args], process.cwd(), true);
const same = (a, b) => a === b || (a !== null && b !== null && a.equals(b));
function paths(root, rev) {
  return git(root, 'ls-tree', '-r', '--name-only', rev).toString('utf8').split('\n').filter(managed);
}
function atRevision(root, rev, name) {
  if (probe(root, 'cat-file', '-e', rev + ':' + name) === null) return null;
  return git(root, 'show', rev + ':' + name);
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
export async function update({root = process.cwd(), source = 'https://github.com/' + origin + '.git', ref = 'main'} = {}) {
  const directory = await fs.realpath(root);
  if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new Error('Invalid upstream ref');
  }
  const stateInfo = await fs.lstat(path.join(directory, stateFile));
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) throw new Error('Unsafe template state');
  const state = JSON.parse(await fs.readFile(path.join(directory, stateFile), 'utf8'));
  if (state.schemaVersion !== 1 || state.source !== origin ||
    typeof state.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(state.sourceRevision)) {
    throw new Error('Invalid template provenance');
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'template-sync-'));
  const upstream = path.join(temp, 'upstream');
  try {
    exec(['clone', '--quiet', '--no-checkout', '--', source, upstream], directory);
    const target = git(upstream, 'rev-parse', ref + '^{commit}').toString('utf8').trim();
    if (target === state.sourceRevision) return {revision: target, updated: []};
    git(upstream, 'cat-file', '-e', state.sourceRevision + '^{commit}');
    const candidates = [...new Set([...paths(upstream, state.sourceRevision), ...paths(upstream, target)])].sort();
    const changes = [], conflicts = [];
    for (const name of candidates) {
      const base = atRevision(upstream, state.sourceRevision, name);
      const theirs = atRevision(upstream, target, name);
      const ours = await local(directory, name);
      const result = await merge(base, ours, theirs);
      if (result.conflict) conflicts.push(name);
      else if (!same(ours, result.value)) changes.push({name, value: result.value});
    }
    if (conflicts.length) throw new Error('Template merge conflicts (no files updated): ' + conflicts.join(', '));
    for (const change of changes) await put(directory, change.name, change.value);
    await put(directory, stateFile, Buffer.from(JSON.stringify({...state, sourceRevision: target}, null, 2) + '\n'));
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
