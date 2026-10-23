#!/usr/bin/env node
// Upstream template maintenance only: downstream registries keep their recorded merge bases.
import {recordTemplateState} from './template-update.mjs';

try {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || args.length === 1 && args[0] === '--check')) {
    throw new Error('Usage: node scripts/template-state.mjs [--check]');
  }
  await recordTemplateState(process.cwd(), args[0] === '--check');
  console.log(args.length ? 'Template baseline is current.' : 'Recorded template file versions.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
