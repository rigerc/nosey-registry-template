import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

export function assertSupportedNode(version = process.versions.node) {
  const match = typeof version === 'string' && /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || Number(match[1]) < 22) throw new Error(`Node.js 22 or newer is required (found ${version}).`);
}

export function defaultRoot(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

export function parseOptions(argv, {root, flags = [], positional = false, usage = 'Invalid arguments'} = {}) {
  const options = {root};
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--schemas') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${usage}: ${arg} requires a directory`);
      options[arg === '--root' ? 'root' : 'schemasDir'] = path.resolve(argv[++i]);
    } else if (flags.includes(arg)) options[arg.slice(2)] = true;
    else if (positional && !arg.startsWith('-')) values.push(arg);
    else throw new Error(`${usage}: unknown or unexpected argument ${arg}`);
  }
  if (positional) options.positional = values;
  return options;
}

export function isDirect(moduleUrl) {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl));
}
