// Shared test fixtures. Every test writes into its own temporary directory and
// drives the real CLI, so behavior is verified through the entry points users run.
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {BEGIN, END} from '../lib/readme.mjs';

export const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const canonicalManifestSchema =
  'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json';
export const canonicalMapSchema =
  'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json';

export function mapDocument(overrides = {}) {
  return {
    schemaVersion: 2,
    registryId: 'example/agent-skills',
    alwaysRecommend: [],
    externalSkills: [],
    technologies: [],
    technologySkills: [],
    combinations: [],
    combinationSkills: [],
    frontendBonusSkills: [],
    frontendPackages: [],
    webFrontendExtensions: [],
    ...overrides,
  };
}

export function manifestDocument(overrides = {}) {
  return {schemaVersion: 1, registryId: 'example/agent-skills', skills: [], ...overrides};
}

export function readmeDocument(catalog = '') {
  return '# Registry template\n\nIntro stays.\n\n' + BEGIN + '\n' + catalog + END + '\n\nFooter stays.\n';
}

/** A SKILL.md document with frontmatter and body text. */
export function skill({name, description, body = 'Follow these steps.'} = {}) {
  const frontmatter = ['---'];

  if (name !== undefined) frontmatter.push('name: ' + JSON.stringify(name));

  if (description !== undefined) frontmatter.push('description: ' + JSON.stringify(description));

  frontmatter.push('---');

  return frontmatter.join('\n') + '\n\n' + body + '\n';
}

/**
 * Creates a temporary registry. `files` maps repository-relative paths to file
 * contents; JSON values are serialized, and nested directories are created.
 */
export async function fixture(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nosey-registry-'));

  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);

    // eslint-disable-next-line no-await-in-loop -- fixture setup order is irrelevant but bounded.
    await mkdir(path.dirname(filename), {recursive: true});
    // eslint-disable-next-line no-await-in-loop -- see above.
    await writeFile(
      filename,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n',
    );
  }

  return {
    root,
    path: (relative) => path.join(root, relative),
    read: (relative) => readFile(path.join(root, relative), 'utf8'),
    json: async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8')),
    run: (script, ...args) =>
      spawnSync(process.execPath, [path.join(scripts, script), ...args], {
        cwd: root,
        encoding: 'utf8',
      }),
    cleanup: () => rm(root, {recursive: true, force: true}),
  };
}

/** A registry with the template's identity, an empty catalog README, and no skills. */
export async function emptyRegistry(map = mapDocument(), manifest = manifestDocument()) {
  return fixture({
    'skills-map.json': map,
    'skills-manifest.json': manifest,
    'README.md': readmeDocument(),
  });
}
