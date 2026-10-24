#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {assertNode22, defaultRoot, isDirect, parseOptions} from './lib/cli.mjs';
import {generateManifest} from './generate-manifest.mjs';
import {generateReadme} from './generate-readme.mjs';
import {validateRegistry} from './validate-registry.mjs';

if (isDirect(import.meta.url)) {
  try {
    assertNode22();
    const options = parseOptions(process.argv.slice(2), {root: defaultRoot(import.meta.url), usage: 'Usage: node scripts/check.mjs [--root dir] [--schemas dir]'});
    await generateManifest({root: options.root, check: true});
    await generateReadme({root: options.root, check: true});
    await validateRegistry({root: options.root, schemasDir: options.schemasDir});
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const files = (await readdir(scriptsDir)).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(scriptsDir, name));
    const libDir = path.join(scriptsDir, 'lib');
    files.push(...(await readdir(libDir)).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(libDir, name)));
    files.push(path.join(scriptsDir, 'test/core-cli.test.mjs'));
    const tests = spawnSync(process.execPath, ['--test', ...files], {cwd: options.root, stdio: 'inherit'});
    if (tests.error) throw tests.error;
    if (tests.status !== 0) process.exitCode = tests.status ?? 1;
    else console.log('Generation, schema validation, and infrastructure tests passed.');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
