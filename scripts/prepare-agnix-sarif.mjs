import {readFileSync, writeFileSync} from 'node:fs';

const [input, output] = process.argv.slice(2);

if (!input || !output || input === output) {
  throw new Error('Usage: node scripts/prepare-agnix-sarif.mjs <input> <output> (distinct paths)');
}

const sarif = JSON.parse(readFileSync(input, 'utf8'));

for (const run of sarif.runs) {
  // agnix 0.59.0 emits an empty URI for repository-level VER-001 findings.
  // GitHub rejects these even though the SARIF schema permits an empty URI.
  run.results = (run.results ?? []).filter((result) => {
    const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the artifact URI at the SARIF input boundary.
    if (typeof uri === 'string' && uri.trim().length > 0) return true;

    console.log(
      `Not uploaded (no artifact location): ${result.ruleId ?? 'unknown'}: ${result.message?.text ?? ''}`,
    );

    return false;
  });
}

// Preserve the original report and lint exit status; only prepare an upload copy.
writeFileSync(output, `${JSON.stringify(sarif, null, 2)}\n`);
