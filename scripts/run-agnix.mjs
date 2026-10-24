import {spawnSync} from 'node:child_process';

const strict = process.argv.slice(2).includes('--strict');
const args = strict ? ['--strict', '.'] : ['.'];
const result = spawnSync('agnix', args, {stdio: 'inherit'});

if (result.error?.code === 'ENOENT') {
  console.error('agnix is not available on PATH. Provision the agnix v0.59.1 executable separately; this command never installs it.');
  process.exitCode = 127;
} else if (result.error) {
  console.error(`Could not run agnix: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
