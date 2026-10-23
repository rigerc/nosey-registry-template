#!/usr/bin/env node
// Dependency-free manifest generator for the Nosey registry template.
// Scans skill files, never executes them, and never writes skills-map.json.
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile, readdir, lstat, writeFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const check = process.argv.includes('--check');
const manifestPath = path.join(root, 'skills-manifest.json');

// Relative so the annotation resolves inside a copied registry, never in the Nosey checkout.
const manifestSchema = './schemas/skills-manifest.schema.json';
const manifestSchemaFile = path.join(root, 'schemas', 'skills-manifest.schema.json');

function scalar(value) {
  const text = value.trim();

  if (text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text);
  }

  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }

  return text;
}

function metadata(content, filename) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');

  if (lines[0] !== '---') throw new Error(filename + ': missing YAML frontmatter');
  const end = lines.indexOf('---', 1);

  if (end === -1) throw new Error(filename + ': unterminated frontmatter');
  const fields = new Map();

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);

    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();

    if (/^[>|][-+]?$/u.test(value)) {
      const block = [];

      while (i + 1 < end && /^\s+/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }

      fields.set(key, value.startsWith('>') ? block.join(' ') : block.join('\n'));
    } else {
      fields.set(key, scalar(value));
    }
  }

  const name = fields.get('name');

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standalone registry decoder validates untrusted JSON/frontmatter without dependencies.
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(filename + ': frontmatter name is required');
  }

  const description = fields.get('description');

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standalone registry decoder validates untrusted JSON/frontmatter without dependencies.
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(filename + ': invalid description');
  }

  return {name, description};
}

async function enumerate(relative = 'skills') {
  const folder = path.join(root, relative);
  const files = [];

  if (relative === 'skills') {
    const info = await lstat(folder).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });

    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('skills must be a regular directory, not a symlink');
  }

  // An external-only registry may have no local skills directory.
  const entries = await readdir(folder, {withFileTypes: true}).catch((error) => {
    if (relative === 'skills' && error.code === 'ENOENT') return [];
    throw error;
  });

  // Traverse one subtree at a time to keep ordering and filesystem usage bounded.
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = path.posix.join(relative, entry.name);

    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      files.push(...(await enumerate(child)));
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(child);
    }
  }

  return files;
}

async function existingAnnotation() {
  let raw;

  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    raw = undefined;
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standalone registry generator reads an untrusted manifest without dependencies.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, '$schema')) {
    return raw['$schema'];
  }

  return existsSync(manifestSchemaFile) ? manifestSchema : undefined;
}

async function main() {
  const settings = JSON.parse(await readFile(path.join(root, 'registry.json'), 'utf8'));

  if (
    settings.schemaVersion !== 1 ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standalone registry decoder validates untrusted JSON/frontmatter without dependencies.
    typeof settings.registryId !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(settings.registryId)
  ) {
    throw new Error('registry.json requires schemaVersion=1 and a valid registryId');
  }

  const records = [];
  const ids = new Set();

  for (const filename of await enumerate()) {
    // eslint-disable-next-line no-await-in-loop
    const info = await lstat(path.join(root, filename));

    if (!info.isFile() || info.isSymbolicLink()) continue;

    const {name, description} = metadata(
      // eslint-disable-next-line no-await-in-loop
      await readFile(path.join(root, filename), 'utf8'),
      filename,
    );

    const folderName = path.posix.dirname(filename).slice('skills/'.length);
    const id = settings.registryId + '/' + folderName;

    if (ids.has(id)) throw new Error('Duplicate skill ID: ' + id);
    ids.add(id);
    const record = {id, name, path: filename};

    if (description) record.description = description;
    records.push(record);
  }

  records.sort((a, b) => a.id.localeCompare(b.id));

  // The annotation is a convention, not contract data: preserve whatever is there,
  // and add the local reference only when this registry actually ships the schema.
  const annotation = await existingAnnotation();
  const document = {schemaVersion: 1, registryId: settings.registryId, skills: records};

  const output =
    JSON.stringify(
      annotation === undefined ? document : {$schema: annotation, ...document},
      null,
      2,
    ) + '\n';

  let mode = 0o666;

  try {
    const info = await lstat(manifestPath);

    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('skills-manifest.json must be a regular file, not a symlink');
    }

    mode = info.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (check) {
    const current = await readFile(manifestPath, 'utf8').catch(() => '');

    if (output !== current)
      throw new Error('skills-manifest.json is out of date; run the generator');
    console.log('Manifest is current (' + records.length + ' skills).');

    return;
  }

  // Replace the directory entry rather than following a symlink or modifying a
  // hard-linked file. Exclusive temporary creation also prevents partial writes.
  const temporary = manifestPath + '.' + randomUUID() + '.tmp';

  try {
    await writeFile(temporary, output, {flag: 'wx', mode});
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, {force: true});
  }

  console.log('Generated skills-manifest.json (' + records.length + ' skills).');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
