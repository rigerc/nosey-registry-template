#!/usr/bin/env node
// Regenerates only the marker-delimited skill catalog in README.md.
// The manifest remains the skill source of truth; the map supplies mappings.
import process from 'node:process';
import {parseArguments, run} from './lib/files.mjs';
import {generateReadme} from './lib/readme.mjs';

const usage = 'Usage: node scripts/generate-readme.mjs [--check]';

await run(async () => {
  const args = parseArguments(process.argv.slice(2), {flags: ['--check'], usage});
  const check = args['--check'] === true;
  const {count} = await generateReadme(process.cwd(), {check});

  if (check) {
    console.log('README skill catalog is current (' + count + ' skills).');

    return;
  }

  console.log('Generated README skill catalog (' + count + ' skills).');
});
