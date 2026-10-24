#!/usr/bin/env node
import process from 'node:process';
import {generateManifest} from './generate-manifest.mjs';
import {generateReadme} from './generate-readme.mjs';
import {assertNode22, defaultRoot, isDirect, parseOptions} from './lib/cli.mjs';

if (isDirect(import.meta.url)) {
  try {
    assertNode22();
    const options = parseOptions(process.argv.slice(2), {root: defaultRoot(import.meta.url), flags: ['--check'], usage: 'Usage: node scripts/generate.mjs [--root dir] [--check]'});
    const manifest = await generateManifest({root: options.root, check: Boolean(options.check)});
    const readme = await generateReadme({root: options.root, check: Boolean(options.check)});
    console.log(options.check ? `Generated files are current (${manifest.manifest.skills.length} skills).` : `Generated manifest and README catalog (${readme.count} skills).`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
