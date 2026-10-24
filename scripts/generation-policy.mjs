import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function shouldGenerate({eventName, ref, headMessage = ''}) {
  return eventName === 'push'
    && ref === 'refs/heads/main'
    && !headMessage.includes('chore(registry): update skill manifest and catalog');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const shouldRun = shouldGenerate({
    eventName: process.env.EVENT_NAME,
    ref: process.env.GITHUB_REF,
    headMessage: process.env.HEAD_MESSAGE,
  });
  if (!process.env.GITHUB_OUTPUT) {
    console.error('GITHUB_OUTPUT is required when running this workflow helper directly.');
    process.exitCode = 2;
  } else {
    appendFileSync(process.env.GITHUB_OUTPUT, `generate=${shouldRun}\n`);
  }
}
