import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  linkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {generateReadme, renderReadme} from './generate-readme.mjs';

const script = new URL('./generate-readme.mjs', import.meta.url);
const begin = '<!-- BEGIN GENERATED SKILL CATALOG -->';
const end = '<!-- END GENERATED SKILL CATALOG -->';
const header = {schemaVersion: 1, registryId: 'example/skills'};
const id = (name) => `${header.registryId}/${name}`;

const record = (name) => ({
  id: id(name),
  name,
  path: `skills/${name}/SKILL.md`,
  description: `Help with ${name}.`,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'readme-catalog-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const manifest = {...header, skills: [record('beta'), record('alpha')]};
  const map = {...header};
  const original = `# Handwritten title\n\n${begin}\nold output\n${end}\n\nKeep these instructions.\n`;

  const save = (readme = original) => {
    writeFileSync(join(root, 'README.md'), readme);
    writeFileSync(join(root, 'skills-manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'skills-map.json'), JSON.stringify(map));
  };

  const read = () => readFileSync(join(root, 'README.md'), 'utf8');

  const run = (...args) =>
    spawnSync(process.execPath, [script.pathname, ...args], {cwd: root, encoding: 'utf8'});

  save();

  return {root, manifest, map, original, save, read, run};
}

void test('renders all skills in stable order and preserves handwritten bytes and source files', (t) => {
  const f = fixture(t);

  const inputs = ['skills-manifest.json', 'skills-map.json'].map((name) =>
    readFileSync(join(f.root, name), 'utf8'),
  );

  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const output = f.read();
  assert.ok(output.indexOf('### [alpha]') < output.indexOf('### [beta]'));
  assert.match(output, /\[alpha\]\(skills\/alpha\/SKILL.md\)/);
  assert.match(output, /Help with alpha\./);
  assert.match(output, /2 skills/);
  assert.equal(output.split('Available; no automatic recommendation.').length - 1, 2);
  assert.equal(
    output.slice(0, output.indexOf(begin)),
    f.original.slice(0, f.original.indexOf(begin)),
  );
  assert.equal(output.slice(output.indexOf(end)), f.original.slice(f.original.indexOf(end)));
  assert.equal(f.run().status, 0);
  assert.equal(f.read(), output, 'second generation must be identical');
  f.manifest.skills.reverse();
  writeFileSync(join(f.root, 'skills-manifest.json'), JSON.stringify(f.manifest));
  assert.equal(f.run().status, 0);
  assert.equal(f.read(), output, 'input ordering must not change the catalog');
  f.manifest.skills.reverse();
  writeFileSync(join(f.root, 'skills-manifest.json'), JSON.stringify(f.manifest));
  assert.deepEqual(
    ['skills-manifest.json', 'skills-map.json'].map((name) =>
      readFileSync(join(f.root, name), 'utf8'),
    ),
    inputs,
  );
  assert.equal(readdirSync(f.root).filter((name) => name.endsWith('.tmp')).length, 0);
});

void test('pure renderer changes only marker contents and performs no writes', (t) => {
  const f = fixture(t);
  const output = renderReadme(f.original, f.manifest, f.map);
  assert.equal(output.slice(0, output.indexOf(begin)), f.original.slice(0, f.original.indexOf(begin)));
  assert.equal(output.slice(output.indexOf(end)), f.original.slice(f.original.indexOf(end)));
  assert.equal(f.read(), f.original);
});

void test('renders all recommendation types and additional frontend detection', (t) => {
  const f = fixture(t);
  f.map.alwaysRecommend = [id('alpha')];
  f.map.technologies = [
    {
      id: 'custom',
      name: 'Custom Tool',
      detect: {packages: ['tool'], fileExtensions: ['.tool']},
      skills: [id('alpha')],
    },
  ];
  f.map.technologySkills = [
    {technologyId: 'bash', skills: [id('beta')]},
    {technologyId: 'custom', skills: [id('alpha')]},
  ];
  f.map.combinations = [
    {id: 'custom-bash', name: 'Custom shell', requires: ['custom', 'bash'], skills: [id('beta')]},
  ];
  f.map.combinationSkills = [
    {combinationId: 'custom-bash', skills: [id('alpha')]},
    {combinationId: 'external-combo', skills: [id('beta')]},
  ];
  f.map.frontendBonusSkills = [id('beta')];
  f.map.frontendPackages = ['react', 'react'];
  f.map.webFrontendExtensions = ['.vue'];
  f.save();
  assert.equal(f.run().status, 0);
  const output = f.read();
  assert.match(output, /Always recommended/);
  assert.match(output, /Bash is detected/);
  assert.ok(
    output.includes('Custom Tool is detected \\(file extensions: .tool; npm packages: tool\\)'),
  );
  assert.equal(
    output.split('Custom Tool is detected').length - 1,
    1,
    'duplicate rules must be merged',
  );
  assert.ok(output.includes('Custom shell is detected \\(requires all: Bash, Custom Tool\\)'));
  assert.ok(
    output.includes('external-combo is detected \\(defined by Nosey or another registry\\)'),
  );
  assert.match(output, /A web frontend is detected/);
  assert.match(output, /npm packages: react\n/);
  assert.match(output, /file extensions: .vue/);
  f.map.technologySkills.reverse();
  f.map.combinations[0].requires.reverse();
  writeFileSync(join(f.root, 'skills-map.json'), JSON.stringify(f.map));
  assert.equal(f.run('--check').status, 0, 'rule ordering must not affect output');
});

void test('describes regex and content detection without executing patterns', (t) => {
  const f = fixture(t);
  f.map.technologies = [
    {
      id: 'content',
      name: 'Content tool',
      skills: [id('alpha')],
      detect: {
        packagePatterns: [{source: '^@tool/', flags: 'i'}],
        configFileContent: {
          files: ['build.gradle'],
          patterns: ['plugin', {source: 'tool', flags: 'i'}],
          allPatterns: true,
          scanGradleLayout: true,
          sourceExtensions: ['.kt'],
          stripComments: 'code',
          maskStrings: true,
        },
      },
    },
  ];
  f.save();
  assert.equal(f.run().status, 0);
  assert.match(f.read(), /npm packages matching: \/\^@tool\/\/i/);
  assert.match(f.read(), /build.gradle containing all of:/);
  assert.match(
    f.read(),
    /source extensions: .kt; Gradle layout; ignore code comments; ignore strings/,
  );
});

void test('renders supported MCP matcher alternatives and config scope as escaped text', (t) => {
  const f = fixture(t);
  f.map.technologies = [{
    id: 'mcp', name: 'MCP', skills: [id('alpha')], detect: {mcpServers: [
      {serverNames: ['<tool>'], configFiles: ['.vscode/mcp.json']},
      {packages: ['@safe/package'], endpoints: ['https://example.test/mcp']},
    ]},
  }];
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.read(), /MCP server matching serverNames: &lt;tool&gt;; configFiles: \.vscode\/mcp\.json/);
  assert.match(f.read(), /MCP server matching packages: @safe\/package; endpoints: https:\/\/example\.test\/mcp/);
  assert.doesNotMatch(f.read(), /<tool>/);
  assert.equal(f.run('--check').status, 0);
});

void test('--check detects stale output, stays read-only, and passes after regeneration', (t) => {
  const f = fixture(t);
  const stale = f.run('--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /out of date/);
  assert.equal(f.read(), f.original);
  assert.equal(f.run().status, 0);
  const current = f.read();
  assert.equal(f.run('--check').status, 0);
  assert.equal(f.read(), current);
  f.map.alwaysRecommend = [id('alpha')];
  writeFileSync(join(f.root, 'skills-map.json'), JSON.stringify(f.map));
  assert.equal(f.run('--check').status, 1, 'map-only changes must make output stale');
  assert.equal(f.read(), current);
});

void test('--root supports isolated direct CLI use and API check mode is read-only', async (t) => {
  const f = fixture(t);
  await assert.rejects(generateReadme({root: f.root, check: true}), /out of date/);
  assert.equal(f.read(), f.original);
  const result = f.run('--root', f.root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.run('--root', f.root, '--check').status, 0);
});

void test('escapes Markdown and HTML and encodes nested skill links', (t) => {
  const f = fixture(t);
  f.manifest.skills = [
    {
      ...record('nested/a b)'),
      name: '[Tool] *name*',
      description: '<script>alert(1)</script> & [link](https://example.com)\nnext line | `code`',
    },
  ];
  f.save();
  assert.equal(f.run().status, 0);
  assert.ok(f.read().includes('### [\\[Tool\\] \\*name\\*](skills/nested/a%20b%29/SKILL.md)'));
  assert.ok(f.read().includes('&lt;script&gt;alert\\(1\\)&lt;/script&gt; &amp; \\[link\\]'));
  assert.ok(!f.read().includes('<script>'));
  assert.ok(f.read().includes('next line \\| \\`code\\`'));
});

void test('encodes punctuation and Unicode in each local URL segment', () => {
  const manifest = {
    ...header,
    skills: [{id: id('nested/a?#% ü'), name: 'Punctuation', path: 'skills/nested/a?#% ü/SKILL.md'}],
  };
  const output = renderReadme(`${begin}\nold\n${end}`, manifest, header);
  assert.match(output, /skills\/nested\/a%3F%23%25%20%C3%BC\/SKILL\.md/);
});

void test('preserves CRLF and supports empty manifests and missing descriptions', (t) => {
  const f = fixture(t);
  f.manifest.skills = [];
  f.save(f.original.replaceAll('\n', '\r\n'));
  assert.equal(f.run().status, 0);
  assert.match(f.read(), /No skills are registered/);
  assert.ok(!f.read().replaceAll('\r\n', '').includes('\n'));
  assert.ok(!f.read().includes('### Additional'));
  assert.equal(f.run('--check').status, 0);
  f.manifest.skills = [record('alpha')];
  delete f.manifest.skills[0].description;
  f.save();
  assert.equal(f.run().status, 0);
  assert.match(f.read(), /1 skill\./);
  assert.ok(!f.read().includes('undefined'));
});

void test('keeps description prefixes from becoming Markdown headings or lists', (t) => {
  const f = fixture(t);

  for (const [description, expected] of [
    ['# Heading', '\\# Heading'],
    ['- item', '\\- item'],
    ['1. item', '1\\. item'],
    ['+ item', '\\+ item'],
  ]) {
    f.manifest.skills[0].description = description;
    f.save();
    assert.equal(f.run().status, 0);
    assert.ok(f.read().includes(`\n\n${expected}\n\n`));
  }
});

void test('rejects missing, duplicate, or reversed markers without modifying README', (t) => {
  const f = fixture(t);

  for (const readme of [
    '# No markers',
    `${begin}\n${begin}\n${end}`,
    `${begin}\n${end}\n${end}`,
    `${end}\n${begin}`,
  ]) {
    f.save(readme);
    assert.equal(f.run().status, 1);
    assert.equal(f.read(), readme);
  }
});

void test('rejects registry mismatches, duplicate IDs, unsafe paths, and unknown detection fields', (t) => {
  for (const change of [
    (f) => {
      f.map.registryId = 'other/registry';
    },
    (f) => {
      f.map.schemaVersion = 3;
    },
    (f) => {
      f.manifest.skills.push(record('alpha'));
    },
    (f) => {
      f.manifest.skills[0].path = 'skills/../beta/SKILL.md';
    },
    (f) => {
      f.manifest.skills[0].id = id('wrong-path');
    },
    (f) => {
      f.map.technologies = [{id: 'bad', name: 'Bad', detect: {unsupported: ['x']}}];
    },
    (f) => {
      f.map.technologies = [{id: 'bad', name: 'Bad', detect: {mcpServers: [{servers: ['tool']}]}}];
    },
  ]) {
    const f = fixture(t);
    change(f);
    f.save();
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.equal(f.read(), f.original);
  }
});

void test('rejects unknown skill references in every recommendation field', (t) => {
  for (const [field, value] of Object.entries({
    alwaysRecommend: [id('missing')],
    technologies: [{id: 'tool', name: 'Tool', detect: {}, skills: [id('missing')]}],
    technologySkills: [{technologyId: 'bash', skills: [id('missing')]}],
    combinations: [{id: 'combo', name: 'Combo', requires: ['bash'], skills: [id('missing')]}],
    combinationSkills: [{combinationId: 'external', skills: [id('missing')]}],
    frontendBonusSkills: [id('missing')],
  })) {
    const f = fixture(t);
    f.map[field] = value;
    f.save();
    const result = f.run();
    assert.equal(result.status, 1, field);
    assert.match(result.stderr, /references unknown skill/);
    assert.equal(f.read(), f.original);
  }
});

void test('refuses README symlinks and unknown command-line options', (t) => {
  const f = fixture(t);
  assert.equal(f.run('--unknown').status, 1);
  assert.equal(f.read(), f.original);
  const target = join(f.root, 'target.md');
  writeFileSync(target, f.original);
  rmSync(join(f.root, 'README.md'));
  symlinkSync(target, join(f.root, 'README.md'));
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(target, 'utf8'), f.original);
});

void test('rejects hard-linked and oversized README outputs without writing', async (t) => {
  const f = fixture(t);
  const hardlink = join(f.root, 'README-copy.md');
  linkSync(join(f.root, 'README.md'), hardlink);
  await assert.rejects(generateReadme({root: f.root}), /must not be hard-linked/);
  assert.equal(f.read(), f.original);
  rmSync(hardlink);
  writeFileSync(join(f.root, 'README.md'), `${f.original}${'x'.repeat(4 * 1024 * 1024)}`);
  const oversized = f.read();
  await assert.rejects(generateReadme({root: f.root}), /README.md exceeds/);
  assert.equal(f.read(), oversized);
});

void test('rejects a generated README above 4 MiB before replacing the original', async (t) => {
  const f = fixture(t);
  f.manifest.skills.forEach((skill) => { skill.description = '<'.repeat(1_100_000); });
  f.save();
  const before = f.read();
  await assert.rejects(generateReadme({root: f.root}), /generated README.md exceeds 4194304 byte limit/);
  assert.equal(f.read(), before);
});

void test('manifest then README generation propagates skill metadata and map-only changes', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'registry.json'), JSON.stringify(header));
  mkdirSync(join(f.root, 'skills', 'nested', 'tool'), {recursive: true});
  const skill = join(f.root, 'skills', 'nested', 'tool', 'SKILL.md');
  writeFileSync(skill, '---\nname: Tool\ndescription: Original description\n---\nInstructions.\n');
  const manifestScript = new URL('./generate-manifest.mjs', import.meta.url);

  const manifest = (...args) =>
    spawnSync(process.execPath, [manifestScript.pathname, ...args], {
      cwd: f.root,
      encoding: 'utf8',
    });

  assert.equal(manifest().status, 0);
  assert.equal(f.run().status, 0);
  assert.match(f.read(), /Original description/);
  writeFileSync(skill, '---\nname: Tool\ndescription: Updated description\n---\nInstructions.\n');
  assert.equal(manifest('--check').status, 1);
  assert.equal(manifest().status, 0);
  assert.equal(f.run('--check').status, 1);
  assert.equal(f.run().status, 0);
  assert.match(f.read(), /Updated description/);
  f.map.technologySkills = [{technologyId: 'bash', skills: [id('nested/tool')]}];
  writeFileSync(join(f.root, 'skills-map.json'), JSON.stringify(f.map));
  assert.equal(manifest('--check').status, 0);
  assert.equal(f.run('--check').status, 1);
  assert.equal(f.run().status, 0);
  assert.match(f.read(), /Bash is detected/);
  assert.equal(f.run('--check').status, 0);
});

void test('supports version 2 maps with local and external recommendations without changing inputs', (t) => {
  const f = fixture(t);
  f.map.schemaVersion = 2;
  f.map.externalSkills = [
    {
      id: 'acme/upstream/helper',
      name: 'External helper',
      source: 'git@github.com:acme/upstream.git',
      skill: 'helper',
      description: 'Upstream guidance.',
    },
  ];
  f.map.alwaysRecommend = ['acme/upstream/helper'];
  f.map.technologySkills = [{technologyId: 'react', skills: [id('alpha'), 'acme/upstream/helper']}];
  f.save();
  const originalMap = readFileSync(join(f.root, 'skills-map.json'), 'utf8');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.read(), /3 skills/);
  assert.match(f.read(), /\[External helper\]\(https:\/\/github.com\/acme\/upstream\)/);
  assert.match(f.read(), /External skill: helper/);
  assert.match(f.read(), /Upstream guidance/);
  assert.match(f.read(), /Always recommended/);
  assert.equal(readFileSync(join(f.root, 'skills-map.json'), 'utf8'), originalMap);
  assert.equal(f.run('--check').status, 0);
});

void test('renders external-only registries for all supported GitHub source spellings', (t) => {
  const f = fixture(t);
  f.manifest.skills = [];
  f.map.schemaVersion = 2;

  for (const source of [
    'acme/upstream',
    'https://github.com/acme/upstream',
    'git@github.com:acme/upstream',
  ]) {
    f.map.externalSkills = [
      {id: 'acme/upstream/helper', name: 'External helper', source, skill: 'helper'},
    ];
    f.save();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.read(), /1 skill\./);
    assert.ok(!f.read().includes('No skills are registered'));
    assert.match(f.read(), /Available; no automatic recommendation/);
    assert.equal(f.run('--check').status, 0);
  }
});

void test('rejects invalid external declarations without changing the README', (t) => {
  for (const change of [
    (f) => {
      f.map.schemaVersion = 1;
    },
    (f) => {
      f.map.externalSkills.push({...f.map.externalSkills[0]});
    },
    (f) => {
      f.map.externalSkills[0].id = id('alpha');
    },
    (f) => {
      f.map.externalSkills[0].source = 'https://example.com/repo';
    },
    (f) => {
      f.map.externalSkills[0].id = 'acme/../helper';
    },
    (f) => {
      f.map.externalSkills[0].skill = '../helper';
    },
  ]) {
    const f = fixture(t);
    f.map.schemaVersion = 2;
    f.map.externalSkills = [
      {id: 'acme/upstream/helper', name: 'Helper', source: 'acme/upstream', skill: 'helper'},
    ];
    change(f);
    f.save();
    assert.equal(f.run().status, 1);
    assert.equal(f.read(), f.original);
  }
});
