#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {assertNode22, defaultRoot, isDirect} from './lib/cli.mjs';

if (isDirect(import.meta.url)) {
  try {
    assertNode22();
    const argv = process.argv.slice(2);
    let root = defaultRoot(import.meta.url), strict = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--strict') strict = true;
      else if (argv[i] === '--root' && argv[i + 1] && !argv[i + 1].startsWith('--')) root = path.resolve(argv[++i]);
      else throw new Error(`Usage: node scripts/run-agnix.mjs [--root dir] [--strict] (unexpected ${argv[i]})`);
    }
    const result = spawnSync('agnix', [...(strict ? ['--strict'] : []), '.'], {cwd: root, stdio: 'inherit'});
    if (result.error?.code === 'ENOENT') { console.error('agnix is not available on PATH. Provision the agnix executable separately; this command never installs it.'); process.exitCode = 127; }
    else if (result.error) { console.error(`Could not run agnix: ${result.error.message}`); process.exitCode = 1; }
    else process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
