// Filesystem and JSON helpers shared by the generators, configure script, and tests.
// Documents are read and replaced through these helpers so the scripts never follow
// symlinks, never write partial files, and never accept oversized input.
import {randomUUID} from 'node:crypto';
import {lstat, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

function label(filename) {
  return path.basename(filename);
}

async function stats(filename, required) {
  const info = await lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

  if (!info) {
    if (required) throw new Error(label(filename) + ' is missing');
    return undefined;
  }

  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(label(filename) + ' must be a regular file, not a symlink');

  if (info.size > MAX_DOCUMENT_BYTES)
    throw new Error(label(filename) + ' is larger than ' + MAX_DOCUMENT_BYTES + ' bytes');

  return info;
}

/** Reads a JSON document; returns undefined when optional and absent. */
export async function readJson(filename, {required = true} = {}) {
  const info = await stats(filename, required);

  if (!info) return undefined;

  const text = await readFile(filename, 'utf8');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(label(filename) + ' is not valid JSON');
  }
}

/** Reads a UTF-8 text file; returns undefined when optional and absent. */
export async function readText(filename, {required = true} = {}) {
  const info = await stats(filename, required);

  if (!info) return undefined;

  return readFile(filename, 'utf8');
}

/** Deterministic JSON document text: two-space indent and a trailing newline. */
export function serialize(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Replaces the directory entry instead of following a symlink or touching a
 * hard-linked file. Exclusive temporary creation prevents partial writes.
 */
export async function writeAtomic(filename, content, mode = 0o666) {
  const temporary = filename + '.' + randomUUID() + '.tmp';

  try {
    await writeFile(temporary, content, {flag: 'wx', mode});
    await rename(temporary, filename);
  } finally {
    await rm(temporary, {force: true});
  }
}

/** Preserves the mode of an existing regular file, defaulting for new files. */
export async function fileMode(filename) {
  const info = await lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

  if (!info) return 0o666;

  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(label(filename) + ' must be a regular file, not a symlink');

  return info.mode & 0o777;
}

/** Writes a JSON document atomically, preserving an existing file's mode. */
export async function writeJson(filename, value) {
  await writeAtomic(filename, serialize(value), await fileMode(filename));
}

/**
 * Parses CLI arguments: every argument must be a known flag, and repeated flags
 * are rejected so a typo cannot silently change behavior.
 */
export function parseArguments(argv, {flags = [], values = [], usage}) {
  const fail = (message) => {
    throw new Error(usage ? message + '\n' + usage : message);
  };

  const result = {};

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];

    if (flags.includes(argument)) {
      if (result[argument] === true) fail('Duplicate argument: ' + argument);

      result[argument] = true;

      continue;
    }

    if (values.includes(argument)) {
      const value = argv[++i];

      if (value === undefined || value.startsWith('--')) fail(argument + ' requires a value');

      if (result[argument] !== undefined) fail('Duplicate argument: ' + argument);

      result[argument] = value;

      continue;
    }

    fail('Unknown argument: ' + argument);
  }

  return result;
}

/** Runs a script body and reports failures on stderr with exit code 1. */
export async function run(main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
