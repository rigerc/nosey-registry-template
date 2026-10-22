import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const script = new URL('./prepare-agnix-sarif.mjs', import.meta.url);

const finding = (ruleId, uri) => ({
  ruleId,
  message: {text: ruleId === 'VER-001' ? 'No tool or spec versions pinned.' : 'File diagnostic'},
  locations: [{physicalLocation: {artifactLocation: {uri}, region: {startLine: 1}}}],
});

function prepare(t, results) {
  const directory = mkdtempSync(join(tmpdir(), 'agnix-sarif-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const input = join(directory, 'raw.sarif');
  const output = join(directory, 'upload.sarif');

  const report = {
    version: '2.1.0',
    runs: [{tool: {driver: {name: 'agnix'}}, results}],
  };

  const original = JSON.stringify(report);
  writeFileSync(input, original);

  const execution = spawnSync(process.execPath, [script.pathname, input, output], {
    encoding: 'utf8',
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(readFileSync(input, 'utf8'), original, 'original diagnostics must remain intact');

  return {report: JSON.parse(readFileSync(output, 'utf8')), stdout: execution.stdout};
}

void test('excludes the agnix VER-001 empty URI while retaining file findings and metadata', (t) => {
  const valid = finding('AS-024', 'skills/agnix/SKILL.md');
  const {report, stdout} = prepare(t, [finding('VER-001', ''), valid]);
  assert.deepEqual(report.runs[0].results, [valid]);
  assert.deepEqual(report.runs[0].tool, {driver: {name: 'agnix'}});
  assert.match(stdout, /Not uploaded \(no artifact location\): VER-001/);
});

void test('supports reports with no findings suitable for code scanning', (t) => {
  const {report} = prepare(t, [finding('VER-001', '')]);
  assert.deepEqual(report.runs[0].results, []);
});

void test('preserves valid reports and handles missing primary locations', (t) => {
  const valid = finding('AS-024', 'skills/agnix/SKILL.md');
  assert.deepEqual(prepare(t, [valid]).report.runs[0].results, [valid]);
  const {report} = prepare(t, [{ruleId: 'VER-001', message: {text: 'Repository finding'}}]);
  assert.deepEqual(report.runs[0].results, []);
});
