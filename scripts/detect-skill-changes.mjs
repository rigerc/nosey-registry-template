import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

function git(args, cwd) {
  return spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
}

export function detectSkillChanges({eventName, baseSha = '', headSha = '', cwd = process.cwd()}) {
  if (eventName === 'workflow_dispatch') return {skills: true, reason: 'manual dispatch'};
  if (!['pull_request', 'push'].includes(eventName)) return {skills: true, reason: `unsupported event: ${eventName}`};
  if (!/^[0-9a-f]{40}$/i.test(headSha)) return {skills: true, reason: 'head commit is unavailable'};

  let base = baseSha;
  if (eventName === 'push' && (!/^[0-9a-f]{40}$/i.test(base) || /^0+$/.test(base))) {
    return {skills: true, reason: 'push has no usable before commit'};
  }
  if (!/^[0-9a-f]{40}$/i.test(base)) return {skills: true, reason: 'base commit is unavailable'};

  if (eventName === 'pull_request') {
    const mergeBase = git(['merge-base', base, headSha], cwd);
    if (mergeBase.status !== 0 || !/^[0-9a-f]{40}$/i.test(mergeBase.stdout.trim())) {
      return {skills: true, reason: 'merge base could not be resolved'};
    }
    base = mergeBase.stdout.trim();
  }

  const result = git(['diff', '--name-status', '-M', '-z', base, headSha], cwd);
  if (result.status !== 0) return {skills: true, reason: 'git diff could not be resolved'};

  const fields = result.stdout.split('\0').filter(Boolean);
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    index += pathCount;
    if (paths.length !== pathCount) return {skills: true, reason: 'git diff output was incomplete'};
    if (paths.some((path) => path.startsWith('skills/'))) {
      return {skills: true, reason: 'skills path changed'};
    }
  }
  return {skills: false, reason: 'no skills paths changed'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = detectSkillChanges({
    eventName: process.env.EVENT_NAME,
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.error('GITHUB_OUTPUT is required when running this workflow helper directly.');
    process.exitCode = 2;
  } else {
    appendFileSync(output, `skills=${result.skills}\nreason=${result.reason}\n`);
    console.log(`Agnix audit ${result.skills ? 'required' : 'not required'}: ${result.reason}`);
  }
}
