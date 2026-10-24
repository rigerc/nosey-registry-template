// Skill discovery and manifest record construction. Only metadata needed for the
// manifest is read; nothing here judges skill content or executes a skill.
import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {frontmatter} from './frontmatter.mjs';

const SKILLS = 'skills';
const FILENAME = 'SKILL.md';

/** Walks skills/ deterministically, skipping symlinks and non-directories. */
async function walk(root, relative, files) {
  const entries = await readdir(path.join(root, relative), {withFileTypes: true}).catch(
    (error) => {
      if (relative === SKILLS && error.code === 'ENOENT') return [];

      throw error;
    },
  );

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;

    const child = path.posix.join(relative, entry.name);

    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop -- one subtree at a time keeps ordering deterministic.
      await walk(root, child, files);
    } else if (entry.isFile() && entry.name === FILENAME) {
      files.push(child);
    }
  }

  return files;
}

/** Returns repository-relative SKILL.md paths, sorted, with symlinks skipped. */
export async function enumerateSkills(root) {
  const info = await lstat(path.join(root, SKILLS)).catch((error) => {
    if (error.code === 'ENOENT') return undefined;

    throw error;
  });

  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new Error('skills must be a regular directory, not a symlink');

  return walk(root, SKILLS, []);
}

/** Local skill ID: <registryId>/<relative directory under skills>. */
export function skillId(registryId, relativePath) {
  const directory = path.posix.dirname(relativePath);

  return registryId + '/' + directory.slice(SKILLS.length + 1);
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Builds manifest records. A missing or blank name falls back to the skill
 * directory name so the manifest stays schema-valid; a missing or non-string
 * description is omitted rather than repaired.
 */
export async function collectSkills(root, registryId) {
  const records = [];
  const ids = new Set();
  const paths = new Set();

  for (const relative of await enumerateSkills(root)) {
    const info = await lstat(path.join(root, relative));

    if (!info.isFile() || info.isSymbolicLink()) continue;

    const data = frontmatter(
      // eslint-disable-next-line no-await-in-loop -- bounded by the repository's own skill tree.
      await readFile(path.join(root, relative), 'utf8'),
      relative,
    );

    const id = skillId(registryId, relative);

    if (ids.has(id)) throw new Error('Duplicate skill ID: ' + id);

    if (paths.has(relative)) throw new Error('Duplicate skill path: ' + relative);

    ids.add(id);
    paths.add(relative);

    const record = {
      id,
      name: trimmed(data.name) ?? path.posix.basename(path.posix.dirname(relative)),
      path: relative,
    };

    const description = trimmed(data.description);

    if (description !== undefined) record.description = description;

    records.push(record);
  }

  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
