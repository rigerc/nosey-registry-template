import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {actionReferences, isPinnedActionReference} from './lib/template-policy.mjs';

const failures = [];

const tracked = spawnSync('git', ['ls-files', '-z'], {encoding: 'utf8'});
if (tracked.status !== 0) failures.push('could not inspect tracked files with git ls-files');
else {
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (/(^|\/)(node_modules|vendor|vendor\-libs)\//i.test(file)) failures.push(`vendored or installed code is tracked: ${file}`);
    if (/\.(?:wasm|node)$/i.test(file) && !file.startsWith('scripts/test/fixtures/')) failures.push(`compiled dependency artifact is tracked: ${file}`);
    if (file.startsWith('scripts/') && file.endsWith('.mjs') && !file.endsWith('.test.mjs')
        && file !== 'scripts/check-template-policy.mjs' && existsSync(file)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\b(?:from\s*|import\s*\(|import\s+)['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
          failures.push(`${file} imports non-built-in, non-relative module ${specifier}`);
        }
      }
      if (/\b(?:npm\s+(?:ci|install)|npx\b|pnpm\s+|yarn\s+|(?:curl|wget)\s)/i.test(source)) {
        failures.push(`${file} invokes an installer or downloads a tool`);
      }
      if (/\b(?:NODE_OPTIONS|--loader(?:=|\s)|--experimental-loader(?:=|\s)|--import(?:=|\s)|importmap|import-map)\b/i.test(source)) {
        failures.push(`${file} configures a Node loader or import map`);
      }
    }
  }
}

const authoredFiles = ['README.md', 'CONTRIBUTING.md'];
for (const file of authoredFiles) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  if (!/not a general YAML validator/i.test(source)
      || !/Quote values that (?:look like|resemble) numbers, booleans, `null`, or timestamps/i.test(source)
      || !/ambiguous or unsupported values may be treated as absent/i.test(source)) {
    failures.push(`${file} must document the bounded frontmatter metadata subset and quoting rule`);
  }
}

const workflowFiles = spawnSync('git', ['ls-files', '-z', '.github/workflows'], {encoding: 'utf8'});
if (workflowFiles.status !== 0) failures.push('could not inspect workflow files');
else for (const file of workflowFiles.stdout.split('\0').filter(Boolean)) {
  if (!existsSync(file)) continue;
  const source = readFileSync(file, 'utf8');
  if (/\b(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install)\b/i.test(source)) failures.push(`${file} contains a dependency installation step`);
  if (/\b(?:NODE_OPTIONS|--loader(?:=|\s)|--import(?:=|\s)|importmap|import-map)\b/i.test(source)) failures.push(`${file} configures a Node loader or import map`);
  if (/cache:\s*npm/i.test(source)) failures.push(`${file} relies on npm cache setup`);
  for (const action of actionReferences(source)) {
    if (!isPinnedActionReference(action)) failures.push(`${file} uses an action without a full immutable commit SHA: ${action}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`::error::${failure}`);
  process.exitCode = 1;
} else {
  console.log('Template policy passed: standalone Node.js 22+ scripts use built-ins and relative imports; no installer, vendored code, or remote loader.');
}
