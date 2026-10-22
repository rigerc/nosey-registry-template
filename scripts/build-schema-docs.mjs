#!/usr/bin/env node
// Dependency-free generator for docs/registry-schema.md.
// The schemas are the single source: titles, descriptions, examples, and the
// x-parserOnly / x-normalization annotations become the generated tables.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const guideFile = path.join(root, 'docs/registry-schema.md');
const schemaDirectory = path.join(root, 'schemas');
const beginMarker = '<!-- BEGIN GENERATED SCHEMA TABLES -->';
const endMarker = '<!-- END GENERATED SCHEMA TABLES -->';
const check = process.argv.includes('--check');

const sources = [
  {name: 'skills-manifest.json', schema: 'skills-manifest.schema.json', versions: '1'},
  {name: 'skills-map.json', schema: 'skills-map.schema.json', versions: '1 and 2'},
];

function resolveNode(node, definitions) {
  if (!node || typeof node !== 'object') return {};

  if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/$defs/')) return node;
  const {['$ref']: _reference, ...siblings} = node;
  // Resolve the target first so a chain such as LocalSkillId -> Text keeps its type.
  const target = resolveNode(definitions[node.$ref.slice('#/$defs/'.length)], definitions);

  return {...target, ...siblings};
}

function objectSchema(node, definitions) {
  if (node.properties) return node;

  for (const branch of node.anyOf ?? []) {
    const resolved = resolveNode(branch, definitions);

    if (resolved.properties) return resolved;
  }

  return undefined;
}

function arrayItem(node, definitions) {
  if (node.items) return resolveNode(node.items, definitions);

  for (const branch of node.anyOf ?? []) {
    const resolved = resolveNode(branch, definitions);

    if (resolved.items) return resolveNode(resolved.items, definitions);
  }

  return undefined;
}

function typeName(node, definitions) {
  const names = [];

  if (node.type) {
    for (const entry of Array.isArray(node.type) ? node.type : [node.type]) names.push(entry);
  }

  for (const branch of node.anyOf ?? []) {
    for (const entry of typeName(resolveNode(branch, definitions), definitions).split(' | ')) {
      names.push(entry);
    }
  }

  const unique = [...new Set(names)];

  return unique.length === 0 ? 'any' : unique.join(' | ');
}

function constraintText(node, definitions) {
  const constraints = [];

  if (node.const !== undefined) constraints.push('must equal `' + JSON.stringify(node.const) + '`');

  if (Array.isArray(node.enum))
    constraints.push('one of ' + node.enum.map((value) => '`' + String(value) + '`').join(', '));

  if (typeof node.pattern === 'string') constraints.push('pattern `' + node.pattern + '`');

  if (node.not?.['pattern']) constraints.push('must not match `' + node.not['pattern'] + '`');

  if (typeof node.minLength === 'number') constraints.push('minLength ' + node.minLength);

  if (typeof node.maxLength === 'number')
    constraints.push('maxLength ' + node.maxLength + ' (code points)');

  if (typeof node.minItems === 'number') constraints.push('minItems ' + node.minItems);

  if (typeof node.maxItems === 'number') constraints.push('maxItems ' + node.maxItems);

  if (typeName(node, definitions) === 'object' && objectSchema(node, definitions)) {
    constraints.push(
      node.additionalProperties === false ? 'unknown keys rejected' : 'unknown keys ignored',
    );
  }

  return constraints.length === 0 ? '—' : constraints.join('; ');
}

function notesText(node) {
  const notes = [];

  if (typeof node.description === 'string') notes.push(node.description);

  if (Array.isArray(node['x-parserOnly']) && node['x-parserOnly'].length > 0) {
    notes.push(
      'Parser-only: ' + node['x-parserOnly'].map((rule) => '`' + rule + '`').join(', ') + '.',
    );
  }

  if (typeof node['x-normalization'] === 'string')
    notes.push('Normalization: ' + node['x-normalization']);

  return notes.length === 0 ? '—' : notes.join(' ');
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function collectRows(node, definitions, versions, field, required, rows) {
  rows.push({
    field,
    type: typeName(node, definitions),
    required,
    constraints: constraintText(node, definitions),
    versions,
    notes: notesText(node),
  });

  const object = objectSchema(node, definitions);

  if (object) {
    const requiredNames = object.required ?? [];

    for (const [name, child] of Object.entries(object.properties ?? {})) {
      collectRows(
        resolveNode(child, definitions),
        definitions,
        versions,
        field + '.' + name,
        requiredNames.includes(name) ? 'yes' : 'no',
        rows,
      );
    }
  }

  // An anyOf may allow a single object or an array of objects.
  // Document both shapes instead of stopping after the object branch.
  const item = arrayItem(node, definitions);

  if (item) collectRows(item, definitions, versions, field + '[]', '—', rows);
}

function tableFor(entry) {
  const definitions = entry.document.$defs ?? {};
  const rows = [];
  const requiredNames = entry.document.required ?? [];

  for (const [name, node] of Object.entries(entry.document.properties ?? {})) {
    const versions = name === 'externalSkills' ? '2' : entry.versions;

    collectRows(
      resolveNode(node, definitions),
      definitions,
      versions,
      name,
      requiredNames.includes(name) ? 'yes' : 'no',
      rows,
    );
  }

  const lines = ['| Field | Type | Required | Constraints | Version | Description and rules |'];
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const row of rows) {
    lines.push(
      '| `' +
        cell(row.field) +
        '` | ' +
        cell(row.type) +
        ' | ' +
        cell(row.required) +
        ' | ' +
        cell(row.constraints) +
        ' | ' +
        cell(row.versions) +
        ' | ' +
        cell(row.notes) +
        ' |',
    );
  }

  return lines.join('\n');
}

function exampleFor(document) {
  const example = Array.isArray(document.examples) ? document.examples[0] : undefined;

  if (example === undefined) return '';

  return ['', 'Example:', '', '```json', JSON.stringify(example, null, 2), '```'].join('\n');
}

function rulesFor(documents) {
  const rules = new Set();

  const collect = (node) => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node['x-parserOnly'])) {
      for (const rule of node['x-parserOnly']) rules.add(rule);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const entry of value) collect(entry);
      } else if (value && typeof value === 'object') {
        collect(value);
      }
    }
  };

  for (const document of documents) collect(document);

  return [...rules].sort((left, right) => left.localeCompare(right));
}

function render(entries) {
  const sections = [];

  for (const entry of entries) {
    const {name, document} = entry;
    sections.push('### `' + name + '` (' + document.title + ')');
    sections.push('');
    sections.push(document.description);
    sections.push('');
    sections.push(tableFor({document, versions: entry.versions}));
    sections.push(exampleFor(document));
    sections.push('');
  }

  sections.push('### Parser-only rules referenced by these schemas');
  sections.push('');
  sections.push(
    'Annotation text never enforces these rules. `nosey registry validate` does, and each name below appears next to the fields it governs.',
  );
  sections.push('');

  for (const rule of rulesFor(entries.map((entry) => entry.document)))
    sections.push('- `' + rule + '`');

  return sections.join('\n').trimEnd();
}

const loaded = [];

for (const entry of sources) {
  const text = await readFile(path.join(schemaDirectory, entry.schema), 'utf8');
  loaded.push({name: entry.name, versions: entry.versions, document: JSON.parse(text)});
}

const current = await readFile(guideFile, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});

if (current === undefined) throw new Error('docs/registry-schema.md is missing; create it first');

const start = current.indexOf(beginMarker);
const end = current.indexOf(endMarker);

if (start === -1 || end === -1 || end < start) {
  throw new Error('docs/registry-schema.md must contain the generated-table markers');
}

const generated =
  current.slice(0, start + beginMarker.length) + '\n' + render(loaded) + '\n' + current.slice(end);

if (check) {
  if (generated !== current) {
    console.error('docs/registry-schema.md is out of date; run make schema-docs');

    process.exitCode = 1;
  } else {
    console.log('Registry schema guide is current.');
  }
} else {
  await writeFile(guideFile, generated);

  console.log('Generated docs/registry-schema.md');
}
