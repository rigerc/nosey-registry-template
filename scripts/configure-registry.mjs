#!/usr/bin/env node
// Rewrites the registry identity and regenerates the manifest and README.
// Preserves $schema annotations, external skills, external IDs, and unknown keys.
import path from 'node:path';
import process from 'node:process';
import {run} from './lib/files.mjs';
import {configureRegistry} from './lib/registry.mjs';

const usage = 'Usage: node scripts/configure-registry.mjs owner/repository [--root directory]';

function parse(argv) {
  const positional = [];
  let root;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];

    if (argument === '--root') {
      root = argv[++i];

      if (!root || root.startsWith('--')) throw new Error('--root requires a directory\n' + usage);

      continue;
    }

    if (argument.startsWith('--')) throw new Error('Unknown argument: ' + argument + '\n' + usage);

    positional.push(argument);
  }

  if (positional.length !== 1) throw new Error(usage);

  return {requested: positional[0], root: path.resolve(root ?? process.cwd())};
}

await run(async () => {
  const {requested, root} = parse(process.argv.slice(2));
  const {previous, count} = await configureRegistry(root, requested);

  console.log(
    'Configured registry ' + requested + ' (was ' + previous + '); ' + count + ' skills.',
  );
});
