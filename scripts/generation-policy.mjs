import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const GENERATED_PATHS = new Set(['README.md', 'skills-manifest.json']);
const BOT_COMMIT = 'chore(registry): update skill manifest and catalog';

/** Choose a safe branch for automatic and manually dispatched generation. */
export function generationDecision({eventName, ref, headMessage = ''}) {
  if (eventName === 'push') {
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref ?? '') || ref === 'refs/heads/HEAD') {
      return {generate: false, reason: 'unsupported-ref'};
    }
    if (ref !== 'refs/heads/main') return {generate: false, reason: 'push-not-main'};
    if (headMessage.includes(BOT_COMMIT)) return {generate: false, reason: 'bot-commit'};
    return {generate: true, branch: 'main', reason: 'push-main'};
  }

  if (eventName === 'workflow_dispatch') {
    const match = /^refs\/heads\/([A-Za-z0-9._/-]+)$/.exec(ref ?? '');
    if (!match || match[1] === 'HEAD' || match[1].split('/').some((part) => !part || part === '.' || part === '..')) {
      return {generate: false, reason: 'unsupported-ref'};
    }
    return {generate: true, branch: match[1], reason: 'manual'};
  }

  return {generate: false, reason: 'unsupported-event'};
}

/** Reject any dirty or staged path except the two generated artifacts. */
export function unexpectedGenerationPaths(statusOutput) {
  const paths = [];
  for (const line of statusOutput.split('\n').filter(Boolean)) {
    const path = line.slice(3).split(' -> ').at(-1);
    if (!GENERATED_PATHS.has(path)) paths.push(path);
  }
  return paths;
}

export function shouldCommitGeneration({statusOutput, stagedDiff = ''}) {
  return unexpectedGenerationPaths(statusOutput).length === 0 && stagedDiff.trim().length > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const decision = generationDecision({
    eventName: process.env.EVENT_NAME,
    ref: process.env.GITHUB_REF,
    headMessage: process.env.HEAD_MESSAGE,
  });
  if (!process.env.GITHUB_OUTPUT) {
    console.error('GITHUB_OUTPUT is required when running this workflow helper directly.');
    process.exitCode = 2;
  } else {
    appendFileSync(process.env.GITHUB_OUTPUT, `generate=${decision.generate}\nbranch=${decision.branch ?? ''}\nreason=${decision.reason}\n`);
    if (!decision.generate) console.log(`Generation skipped: ${decision.reason}`);
  }
}
