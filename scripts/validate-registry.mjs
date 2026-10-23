#!/usr/bin/env node
// Nosey owns the contract. Always fetch its latest schemas; never follow a
// registry document's $schema annotation or fall back to an older cached copy.
import Ajv2020 from 'ajv/dist/2020.js';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const schemaBase = 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/';

async function latestSchema(name, request) {
  const url = schemaBase + name;
  try {
    const response = await request(url, {
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    throw new Error('Cannot load latest Nosey schema ' + url + ': ' + error.message);
  }
}

export async function validateRegistry(directory = process.cwd(), request = fetch) {
  const [manifestSchema, mapSchema] = await Promise.all([
    latestSchema('skills-manifest.schema.json', request),
    latestSchema('skills-map.schema.json', request),
  ]);
  const ajv = new Ajv2020({strict: true, allErrors: true});
  // Nosey's documentation annotations do not impose additional constraints.
  ajv.addKeyword({keyword: 'x-parserOnly', schemaType: 'array', valid: true});
  ajv.addKeyword({keyword: 'x-normalization', schemaType: 'string', valid: true});
  const manifest = ajv.compile(manifestSchema);
  const map = ajv.compile(mapSchema);

  for (const name of ['registry.json', 'skills-manifest.json', 'skills-map.json']) {
    let value;
    try {
      value = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    } catch (error) {
      throw new Error('Cannot read ' + name + ': ' + error.message);
    }
    // Nosey has no separate registry.json schema. Its validator checks this
    // header with parseManifest({...settings, skills: []}); use the same contract.
    if (name === 'registry.json' && value && typeof value === 'object' && !Array.isArray(value)) {
      value = {...value, skills: []};
    }
    const validate = name === 'skills-map.json' ? map : manifest;
    if (!validate(value)) {
      throw new Error(ajv.errorsText(validate.errors, {dataVar: name, separator: '; '}));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/validate-registry.mjs');
    await validateRegistry();
    console.log('Registry JSON matches the latest Nosey schemas (3 files).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
