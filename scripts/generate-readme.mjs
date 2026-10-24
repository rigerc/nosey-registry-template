#!/usr/bin/env node
// oxlint-disable anti-slop/no-runtime-typeof -- Standalone decoder validates untrusted registry JSON without dependencies.
// Render only the marked catalog; the manifest and map remain the source of truth.
import {randomUUID} from 'node:crypto';
import {lstat, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const begin = '<!-- BEGIN GENERATED SKILL CATALOG -->';
const end = '<!-- END GENERATED SKILL CATALOG -->';
const FILE_LIMIT = 4 * 1024 * 1024;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values) => [...new Set(values)].sort(compare);

function text(value, context) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${context} must be nonempty text`);

  return value;
}

function array(value, context) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);

  return value;
}

function strings(value, context) {
  return array(value, context).map((item) => text(item, context));
}

function escape(value) {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_[\]{}()|#!+~]/g, '\\$&')
    .replace(/^-/, '\\-')
    .replace(/^(\d+)\.(?= )/, '$1\\.');
}

const labels = {bash: 'Bash', ink: 'Ink', just: 'Just', vitest: 'Vitest'};

const detectionLabels = {
  packages: 'npm packages',
  pythonPackages: 'Python packages',
  composerPackages: 'Composer packages',
  goModules: 'Go modules',
  rustCrates: 'Rust crates',
  elixirPackages: 'Elixir packages',
  gems: 'Ruby gems',
  configFiles: 'config files',
  fileExtensions: 'file extensions',
};
const mcpMatcherFields = ['packages', 'pythonPackages', 'endpoints', 'serverNames', 'configFiles'];
const mcpIdentityFields = new Set(['packages', 'pythonPackages', 'endpoints', 'serverNames']);

function mcpSummary(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('detect.mcpServers must be an array with at most 64 matchers');
  return value.map((matcher) => {
    if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) throw new Error('detect.mcpServers entries must be objects');
    for (const key of Object.keys(matcher)) if (!mcpMatcherFields.includes(key)) throw new Error(`Unknown mcpServers matcher field: ${key}`);
    const fields = [];
    for (const key of mcpMatcherFields) {
      if (matcher[key] === undefined) continue;
      const values = strings(matcher[key], `mcpServers.${key}`);
      if (!values.length || values.length > 64) throw new Error(`mcpServers.${key} requires 1 to 64 entries`);
      if (key === 'configFiles' && values.some((file) => file.includes('\\') || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..') || !['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.codex/config.toml'].some((location) => file === location || file.endsWith(`/${location}`)))) {
        throw new Error('mcpServers.configFiles requires normalized project-relative MCP config paths');
      }
      if (values.length) fields.push(`${key}: ${sorted(values).join(', ')}`);
    }
    if (!Object.keys(matcher).some((key) => mcpIdentityFields.has(key) && Array.isArray(matcher[key]) && matcher[key].length)) throw new Error('mcpServers matcher requires an identity');
    const identity = fields.filter((field) => mcpIdentityFields.has(field.slice(0, field.indexOf(':'))));
    const scope = fields.filter((field) => field.startsWith('configFiles:'));
    return `MCP server matching ${[...identity, ...scope].join('; ')}`;
  });
}

function pattern(value) {
  if (typeof value === 'string') return text(value, 'content pattern');
  const source = text(value?.source, 'regex source');
  const flags = value.flags ?? '';

  if (typeof flags !== 'string') throw new Error('regex flags must be text');
  // Validate syntax without running patterns against any input.
  new RegExp(source, flags);

  return `/${source}/${flags}`;
}

function detectionSummary(detect) {
  if (!detect || typeof detect !== 'object' || Array.isArray(detect)) {
    throw new Error('technology.detect must be an object');
  }

  const summaries = [];

  for (const key of Object.keys(detect).sort(compare)) {
    if (detectionLabels[key]) {
      const values = sorted(strings(detect[key], `detect.${key}`));

      if (values.length) summaries.push(`${detectionLabels[key]}: ${values.join(', ')}`);
    } else if (key === 'packagePatterns') {
      const values = sorted(array(detect[key], key).map(pattern));

      if (values.length) summaries.push(`npm packages matching: ${values.join(', ')}`);
    } else if (key === 'configFileContent') {
      const blocks = Array.isArray(detect[key]) ? detect[key] : [detect[key]];

      for (const block of blocks) {
        const patterns = sorted(array(block?.patterns, 'content patterns').map(pattern));

        if (!patterns.length) throw new Error('content patterns must not be empty');
        const files = sorted(strings(block.files, 'content files'));
        const extensions = sorted(strings(block.sourceExtensions, 'source extensions'));
        const scope = files.length ? files.join(', ') : 'config files';
        const options = [];

        if (extensions.length) options.push(`source extensions: ${extensions.join(', ')}`);

        if (block.scanGradleLayout) options.push('Gradle layout');

        if (block.scanDotNetLayout) options.push('.NET layout');

        if (block.stripComments) options.push(`ignore ${block.stripComments} comments`);

        if (block.maskStrings) options.push('ignore strings');
        summaries.push(
          `${scope} containing ${block.allPatterns ? 'all' : 'any'} of: ${patterns.join(', ')}${options.length ? ` (${options.join('; ')})` : ''}`,
        );
      }
    } else if (key === 'mcpServers') {
      summaries.push(...mcpSummary(detect[key]));
    } else {
      throw new Error(`Unknown detection field: ${key}`);
    }
  }

  return sorted(summaries).join('; ');
}

function index(entries, context) {
  const result = new Map();

  for (const entry of array(entries, context)) {
    const id = text(entry?.id, `${context} ID`);

    if (result.has(id)) throw new Error(`Duplicate ${context} ID: ${id}`);
    text(entry.name, `${context} name`);
    result.set(id, entry);
  }

  return result;
}

export function renderCatalog(manifest, map) {
  for (const [filename, value] of [
    ['skills-manifest.json', manifest],
    ['skills-map.json', map],
  ]) {
    const versions = filename === 'skills-map.json' ? [1, 2] : [1];

    if (
      !versions.includes(value?.schemaVersion) ||
      !/^[\w.-]+\/[\w.-]+$/.test(value.registryId ?? '')
    ) {
      throw new Error(`${filename} requires a supported schemaVersion and a valid registryId`);
    }
  }

  if (manifest.registryId !== map.registryId)
    throw new Error('Manifest and map registry IDs must match');

  if (!Array.isArray(manifest.skills)) throw new Error('manifest.skills must be an array');
  const skills = index(manifest.skills, 'skill');

  if (map.schemaVersion === 1 && map.externalSkills !== undefined) {
    throw new Error('externalSkills requires skills-map.json schemaVersion 2');
  }

  const external = index(map.externalSkills, 'external skill');
  const externalLinks = new Map();

  for (const [id, skill] of external) {
    if (skills.has(id)) throw new Error(`Duplicate skill ID: ${id}`);

    if (
      !/^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(id) ||
      id.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new Error(`Invalid external skill ID: ${id}`);
    }

    const source = text(skill.source, 'external skill.source');

    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*?)(?:\.git)?\/?$/i.exec(
        source,
      );

    if (!match || match[1].split('/').some((part) => part === '..' || part.endsWith('.'))) {
      throw new Error(`Invalid external skill source: ${source}`);
    }

    const name = text(skill.skill, 'external skill.skill');

    if (!/^[A-Za-z0-9_.@-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error(`Invalid external skill name: ${name}`);
    }

    externalLinks.set(id, `https://github.com/${match[1]}`);
    skills.set(id, skill);
  }

  const technologies = index(map.technologies, 'technology');
  const combinations = index(map.combinations, 'combination');
  const recommendations = new Map([...skills.keys()].map((id) => [id, new Set()]));
  const technologyName = (id) => technologies.get(id)?.name ?? labels[id] ?? id;

  const technologyRule = (id) => {
    text(id, 'technology ID');
    const technology = technologies.get(id);
    const summary = technology ? detectionSummary(technology.detect) : '';

    return `${technologyName(id)} is detected${summary ? ` (${summary})` : ''}`;
  };

  const combinationRule = (id) => {
    text(id, 'combination ID');
    const combination = combinations.get(id);

    if (!combination) return `Combination ${id} is detected (defined by Nosey or another registry)`;
    const requires = sorted(strings(combination.requires, 'combination.requires'));

    if (!requires.length) throw new Error(`Combination ${id} requires technologies`);

    return `${combination.name} is detected (requires all: ${requires.map(technologyName).join(', ')})`;
  };

  const recommend = (ids, rule, context) => {
    for (const id of strings(ids, context)) {
      if (!skills.has(id)) throw new Error(`${context} references unknown skill: ${id}`);
      recommendations.get(id).add(rule);
    }
  };

  recommend(map.alwaysRecommend, 'Always recommended', 'alwaysRecommend');

  for (const technology of technologies.values()) {
    recommend(technology.skills, technologyRule(technology.id), 'technology.skills');
  }

  for (const binding of array(map.technologySkills, 'technologySkills')) {
    recommend(binding.skills, technologyRule(binding.technologyId), 'technologySkills');
  }

  for (const combination of combinations.values()) {
    recommend(combination.skills, combinationRule(combination.id), 'combination.skills');
  }

  for (const binding of array(map.combinationSkills, 'combinationSkills')) {
    recommend(binding.skills, combinationRule(binding.combinationId), 'combinationSkills');
  }

  recommend(map.frontendBonusSkills, 'A web frontend is detected', 'frontendBonusSkills');

  const lines = [
    '## Skill catalog',
    '',
    `Registry: ${escape(manifest.registryId)} · ${skills.size} ${skills.size === 1 ? 'skill' : 'skills'}.`,
    '',
    'Generated from [skills-manifest.json](skills-manifest.json) and [skills-map.json](skills-map.json). Edit those sources or skill frontmatter, then regenerate this section.',
    '',
    'Recommendation conditions below are alternatives; matching any condition can recommend a skill. Technology detection is handled by Nosey.',
    '',
  ];

  if (!skills.size) lines.push('No skills are registered.', '');

  for (const [id, skill] of [...skills].sort(([a], [b]) => compare(a, b))) {
    let link = externalLinks.get(id);

    if (!link) {
      const filename = text(skill.path, 'skill.path');

      if (
        !filename.startsWith('skills/') ||
        !filename.endsWith('/SKILL.md') ||
        filename.includes('\\') ||
        // Reject control characters in paths supplied by registry metadata.
        // oxlint-disable-next-line no-control-regex
        /[\x00-\x1f\x7f]/.test(filename) ||
        filename.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        throw new Error(`Invalid skill path: ${filename}`);
      }

      const expectedId = `${manifest.registryId}/${filename.slice(7, -9)}`;

      if (id !== expectedId) throw new Error(`Skill ID does not match path: ${id}`);
      link = filename
        .split('/')
        .map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        )
        .join('/');
    }

    lines.push(`### [${escape(skill.name)}](${link})`, '');

    if (external.has(id)) lines.push(`External skill: ${escape(skill.skill)}.`, '');

    if (skill.description !== undefined) {
      lines.push(escape(text(skill.description, 'skill.description')), '');
    }

    const rules = sorted(recommendations.get(id));

    if (rules.length) {
      lines.push('**Recommended when:**', '', ...rules.map((rule) => `- ${escape(rule)}`), '');
    } else {
      lines.push('Available; no automatic recommendation.', '');
    }
  }

  const frontend = [];

  for (const [field, label] of [
    ['frontendPackages', 'npm packages'],
    ['webFrontendExtensions', 'file extensions'],
  ]) {
    const values = sorted(strings(map[field], field));

    if (values.length) frontend.push(`- ${label}: ${escape(values.join(', '))}`);
  }

  if (frontend.length) {
    lines.push(
      '### Additional web frontend detection',
      '',
      'These extend Nosey’s built-in frontend detection rules:',
      '',
      ...frontend,
      '',
    );
  }

  return lines.join('\n');
}

/** Render a README without touching the filesystem. Only marker contents change. */
export function renderReadme(readme, manifest, map) {
  if (typeof readme !== 'string') throw new Error('README content must be text');
  const start = readme.indexOf(begin);
  const finish = readme.indexOf(end);

  if (
    start === -1 ||
    finish <= start ||
    readme.indexOf(begin, start + begin.length) !== -1 ||
    readme.indexOf(end, finish + end.length) !== -1
  ) {
    throw new Error(
      'README.md requires exactly one ordered pair of generated skill catalog markers',
    );
  }

  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  const section = renderCatalog(manifest, map).replaceAll('\n', newline);
  return (
    readme.slice(0, start + begin.length) +
    newline +
    newline +
    section +
    newline +
    readme.slice(finish)
  );
}

async function readRegularFile(filename, label) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  if (info.size > FILE_LIMIT) throw new Error(`${label} exceeds ${FILE_LIMIT} byte limit`);
  return {info, content: await readFile(filename, 'utf8')};
}

async function readJson(filename, label) {
  const {content} = await readRegularFile(filename, label);
  return JSON.parse(content);
}

export async function generateReadme({root = process.cwd(), check = false} = {}) {
  const base = path.resolve(root);
  const filename = path.join(base, 'README.md');
  const [{info, content}, manifest, map] = await Promise.all([
    readRegularFile(filename, 'README.md'),
    readJson(path.join(base, 'skills-manifest.json'), 'skills-manifest.json'),
    readJson(path.join(base, 'skills-map.json'), 'skills-map.json'),
  ]);
  if (info.nlink > 1) throw new Error('README.md must not be hard-linked');
  const output = renderReadme(content, manifest, map);
  if (Buffer.byteLength(output) > FILE_LIMIT) {
    throw new Error(`generated README.md exceeds ${FILE_LIMIT} byte limit`);
  }

  if (check) {
    if (output !== content) {
      throw new Error('README.md is out of date; run node scripts/generate-readme.mjs');
    }
    return {changed: false, count: manifest.skills.length + array(map.externalSkills, 'externalSkills').length};
  }

  if (output !== content) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, output, {flag: 'wx', mode: info.mode & 0o777});
      await rename(temporary, filename);
    } finally {
      await rm(temporary, {force: true});
    }
  }
  return {
    changed: output !== content,
    count: manifest.skills.length + array(map.externalSkills, 'externalSkills').length,
  };
}

async function main(args) {
  let root = process.cwd();
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else throw new Error('Usage: node scripts/generate-readme.mjs [--root <dir>] [--check]');
  }
  const result = await generateReadme({root, check});
  console.log(
    check
      ? 'README skill catalog is current.'
      : `Generated README skill catalog (${result.count} skills).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
