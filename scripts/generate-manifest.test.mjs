// Annotation lifecycle for the dependency-free manifest generator.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const template = fileURLToPath(new URL('..', import.meta.url));
const generator = fileURLToPath(new URL('./generate-manifest.mjs', import.meta.url));
const annotation = './schemas/skills-manifest.schema.json';

async function registry(run, {schemas = true, manifestFile = true, mutate} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nosey-generator-'));

  try {
    // Copy only inputs; maintainers may have a large node_modules directory.
    for (const name of ['registry.json', 'skills-manifest.json']) {
      await fs.cp(path.join(template, name), path.join(directory, name));
    }

    // Isolate the fixture from this registry's identity and shipped skills; the
    // assertions below describe the empty template registry.
    await fs.writeFile(
      path.join(directory, 'registry.json'),
      JSON.stringify({schemaVersion: 1, registryId: 'example/agent-skills'}, null, 2) + '\n',
    );
    await writeManifest(directory, {
      schemaVersion: 1, registryId: 'example/agent-skills', skills: [],
    });
    await fs.rm(path.join(directory, 'skills'), {recursive: true, force: true});

    if (schemas) {
      await fs.mkdir(path.join(directory, 'schemas'), {recursive: true});
      await fs.writeFile(path.join(directory, 'schemas/skills-manifest.schema.json'), '{}\n');
    }

    if (!manifestFile) await fs.rm(path.join(directory, 'skills-manifest.json'), {force: true});

    if (mutate) await mutate(directory);

    return await run(directory);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
}

async function generate(directory) {
  await execFileAsync(process.execPath, [generator], {cwd: directory});
}

async function check(directory) {
  await execFileAsync(process.execPath, [generator, '--check'], {cwd: directory});
}

async function readManifest(directory) {
  return JSON.parse(await fs.readFile(path.join(directory, 'skills-manifest.json'), 'utf8'));
}

async function writeManifest(directory, document) {
  await fs.writeFile(
    path.join(directory, 'skills-manifest.json'),
    JSON.stringify(document, null, 2) + '\n',
  );
}

void test('regeneration preserves the annotation and stays byte-identical', async () => {
  await registry(async (directory) => {
    await generate(directory);
    const first = await fs.readFile(path.join(directory, 'skills-manifest.json'), 'utf8');
    assert.equal(JSON.parse(first).$schema, annotation);

    await generate(directory);
    const second = await fs.readFile(path.join(directory, 'skills-manifest.json'), 'utf8');

    assert.equal(second, first);
    await check(directory);
  });
});

void test('a missing manifest gains the local annotation only when the schema ships', async () => {
  await registry(
    async (directory) => {
      await generate(directory);
      const manifest = await readManifest(directory);

      assert.equal(manifest.$schema, annotation);
      assert.deepEqual(manifest.skills, []);
      await check(directory);
    },
    {manifestFile: false},
  );

  await registry(
    async (directory) => {
      await generate(directory);
      const manifest = await readManifest(directory);

      assert.equal(Object.hasOwn(manifest, '$schema'), false);
      await check(directory);
    },
    {manifestFile: false, schemas: false},
  );
});

void test('a legacy registry without schemas keeps unannotated output stable', async () => {
  await registry(
    async (directory) => {
      await generate(directory);
      await generate(directory);
      await check(directory);
      assert.equal(Object.hasOwn(await readManifest(directory), '$schema'), false);
    },
    {
      schemas: false,
      mutate: (directory) =>
        writeManifest(directory, {
          schemaVersion: 1,
          registryId: 'example/agent-skills',
          skills: [],
        }),
    },
  );
});

void test('existing annotation values are preserved verbatim', async () => {
  for (const value of ['https://example.com/custom.json', 3, null]) {
    await registry(
      async (directory) => {
        await generate(directory);
        const manifest = await readManifest(directory);

        assert.deepEqual(manifest.$schema, value);
        await check(directory);
      },
      {
        mutate: (directory) =>
          writeManifest(directory, {
            ['$schema']: value,
            schemaVersion: 1,
            registryId: 'example/agent-skills',
            skills: [],
          }),
      },
    );
  }
});

void test('the first annotated write differs only by the annotation', async () => {
  await registry(
    async (directory) => {
      await generate(directory);
      const manifest = await readManifest(directory);

      assert.equal(manifest.$schema, annotation);
      const {['$schema']: _annotation, ...rest} = manifest;

      assert.deepEqual(rest, {schemaVersion: 1, registryId: 'example/agent-skills', skills: []});
      await check(directory);
    },
    {
      mutate: (directory) =>
        writeManifest(directory, {
          schemaVersion: 1,
          registryId: 'example/agent-skills',
          skills: [],
        }),
    },
  );
});
