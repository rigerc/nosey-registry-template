#!/usr/bin/env node
// Generates skills-manifest.json from skills-map.json identity and skill metadata.
// The generator reads frontmatter only; skill content and frontmatter quality
// belong to agnix, and this script never executes a skill.
import process from 'node:process';
import {parseArguments, run} from './lib/files.mjs';
import {generateManifest} from './lib/registry.mjs';

const usage = 'Usage: node scripts/generate-manifest.mjs [--check]';

await run(async () => {
  const args = parseArguments(process.argv.slice(2), {flags: ['--check'], usage});
  const {count} = await generateManifest(process.cwd(), {check: args['--check'] === true});

  if (args['--check']) {
    console.log('Manifest is current (' + count + ' skills).');

    return;
  }

  console.log('Generated skills-manifest.json (' + count + ' skills).');
});
