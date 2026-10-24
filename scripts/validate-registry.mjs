#!/usr/bin/env node
// Validates the registry documents against the latest Nosey schemas.
// Skill content is not validated here; agnix owns skills/**.
import process from 'node:process';
import {parseArguments, run} from './lib/files.mjs';
import {validateRegistry} from './lib/validate.mjs';

const usage =
  'Usage: node scripts/validate-registry.mjs [--schemas directory]\n' +
  '  --schemas  Validate against schemas in a local directory (tests and offline fixtures only)';

await run(async () => {
  const args = parseArguments(process.argv.slice(2), {values: ['--schemas'], usage});
  const {skills, external, source} = await validateRegistry(process.cwd(), {
    schemas: args['--schemas'],
  });

  console.log(
    'Validated ' +
      skills +
      ' skills and ' +
      external +
      ' external skills against ' +
      source +
      '.',
  );
});
