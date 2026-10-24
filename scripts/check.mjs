#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {assertNode22, defaultRoot, isDirect, parseOptions} from './lib/cli.mjs';
import {generateManifest} from './generate-manifest.mjs';
import {generateReadme} from './generate-readme.mjs';
import {validateRegistry} from './validate-registry.mjs';

async function findTests(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(full));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(full);
  }
  return files.sort();
}

if (isDirect(import.meta.url)) {
  try {
    assertNode22();
    const options = parseOptions(process.argv.slice(2), {root: defaultRoot(import.meta.url), usage: 'Usage: node scripts/check.mjs [--root dir] [--schemas dir]'});
    await generateManifest({root: options.root, check: true});
    await generateReadme({root: options.root, check: true});
    await validateRegistry({root: options.root, schemasDir: options.schemasDir});
    const checkoutRoot = defaultRoot(import.meta.url);
    const testFiles = await findTests(path.join(checkoutRoot, 'scripts'));
    const tests = spawnSync(process.execPath, ['--test', ...testFiles], {cwd: checkoutRoot, encoding: 'utf8'});
    if (tests.stdout) process.stdout.write(tests.stdout);
    if (tests.stderr) process.stderr.write(tests.stderr);
    if (tests.error) throw tests.error;
    if (tests.signal) {
      console.error(`Test runner terminated by ${tests.signal}.`);
      try { process.kill(process.pid, tests.signal); } catch { process.exitCode = 1; }
    } else if (tests.status !== 0) process.exitCode = tests.status ?? 1;
    else console.log('Generation, schema validation, and infrastructure tests passed.');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
