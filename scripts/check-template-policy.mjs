import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {actionReferences, isPinnedActionReference} from './lib/template-policy.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const failures = [];
const scripts = packageJson.scripts ?? {};
const required = ['generate', 'generate:check', 'validate', 'configure', 'test', 'check', 'lint', 'lint:strict'];

for (const name of required) if (!scripts[name]) failures.push(`package.json is missing script ${name}`);
if (packageJson.dependencies || packageJson.devDependencies) failures.push('package.json must not declare package or development dependencies');
if (packageJson.engines?.node !== '>=22 <23') failures.push('package.json must require Node.js 22 only');
if (/\b(?:npm\s+(?:ci|install)|npx\b|pnpm\s|yarn\s|(?:curl|wget)\s)/i.test(JSON.stringify(scripts))) {
  failures.push('package scripts must not install or download tools/dependencies');
}
for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
  if (existsSync(new URL(`../${name}`, import.meta.url))) failures.push(`${name} is not allowed`);
}
if (existsSync(new URL('../node_modules', import.meta.url))) failures.push('node_modules exists; CI must use a clean checkout with no installed packages');

const tracked = spawnSync('git', ['ls-files', '-z'], {encoding: 'utf8'});
if (tracked.status !== 0) failures.push('could not inspect tracked files with git ls-files');
else {
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (/(^|\/)(node_modules|vendor|vendor\-libs)\//i.test(file)) failures.push(`vendored or installed code is tracked: ${file}`);
    if (/\.(?:wasm|node)$/i.test(file) && !file.startsWith('scripts/test/fixtures/')) failures.push(`compiled dependency artifact is tracked: ${file}`);
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

if (/\b(?:NODE_OPTIONS|--loader(?:=|\s)|--experimental-loader(?:=|\s)|--import(?:=|\s)|importmap|import-map)\b/i.test(JSON.stringify(packageJson))) {
  failures.push('package.json configures a Node loader or import map');
}

if (failures.length) {
  for (const failure of failures) console.error(`::error::${failure}`);
  process.exitCode = 1;
} else {
  console.log('Template policy passed: Node 22 built-ins only, no install, lockfile, vendored code, or remote loader.');
}
