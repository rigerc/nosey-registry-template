import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertSchemaSupported, validateSchema} from './schema-validator.mjs';

test('handles boolean schemas, refs, escaped pointers and structural equality', () => {
  assert.equal(validateSchema(true, {anything: 1}).valid, true);
  assert.equal(validateSchema(false, null).valid, false);
  const schema = {$ref: '#/$defs/a~1b~0c', $defs: {'a/b~c': {const: {x: [1, {y: true}]}}}, minProperties: 1};
  assert.equal(validateSchema(schema, {x: [1, {y: true}]}).valid, true);
  assert.equal(validateSchema({enum: [{b: 3}, {a: [1, 2]}]}, {a: [1, 2]}).valid, true);
});

test('diagnostics identify failing nested instance path and keyword', () => {
  const result = validateSchema({type: 'object', properties: {a: {type: 'array', items: {type: 'string'}}}}, {a: [false]});
  assert.deepEqual(result.errors, [{path: '/a/0', keyword: 'type', message: 'must be string'}]);
});

test('reports all applicable sibling assertions and applicators', () => {
  const result = validateSchema({
    type: 'object', required: ['needed'], minProperties: 2,
    properties: {value: {type: 'string', minLength: 4}},
    additionalProperties: false,
  }, {value: 'x', extra: true});
  assert.ok(result.errors.some((error) => error.keyword === 'required' && error.path === ''));
  assert.ok(result.errors.some((error) => error.keyword === 'minLength' && error.path === '/value'));
  assert.ok(result.errors.some((error) => error.keyword === 'additionalProperties' && error.path === ''));
});

test('rejects invalid schema shapes even in unused definitions', () => {
  for (const schema of [
    {$defs: {unused: {type: 'not-a-json-type'}}},
    {properties: []},
    {pattern: '['},
    {minItems: -1},
    {required: ['x', 'x']},
    {allOf: []},
  ]) assert.throws(() => assertSchemaSupported(schema), /Invalid schema/);
});

test('supports every reviewed annotation while rejecting arbitrary extensions', () => {
  const schema = {
    $id: 'x', $schema: 'x', title: 'x', description: 'x', examples: [{patternProperties: {}}],
    $comment: 'x', default: {unknown: 1}, deprecated: true, readOnly: true, writeOnly: true,
    'x-parserOnly': ['x'], 'x-normalization': 'x', 'x-builtInTechnologies': [{id: 'react', name: 'React', patternProperties: {}}],
    'x-builtInCombinations': [{id: 'react:next', name: 'React + Next', bogus: true}], type: 'object',
  };
  assert.equal(validateSchema(schema, {}).valid, true);
  assert.throws(() => assertSchemaSupported({'x-arbitrary': true}), /unsupported keyword/);
});

test('rejects invalid targets, remote refs and cyclic refs without fetching', () => {
  for (const schema of [
    {$ref: 'https://example.invalid/schema'},
    {$ref: '#/$defs/scalar', $defs: {scalar: 'not a schema'}},
    {$ref: '#/$defs/loop', $defs: {loop: {$ref: '#/$defs/loop'}}},
    {$ref: '#/$defs/a~2b', $defs: {'a~2b': true}},
  ]) assert.throws(() => assertSchemaSupported(schema), /Invalid schema/);
});

test('JSON Pointer paths escape property names and const treats object key order as irrelevant', () => {
  const schema = {properties: {'a/b~c': {const: {first: [1], second: true}}}};
  const result = validateSchema(schema, {'a/b~c': {second: true, first: [1]}});
  assert.deepEqual(result, {valid: true, errors: []});
  const mismatch = validateSchema({properties: {'a/b~c': {type: 'null'}}}, {'a/b~c': 4});
  assert.equal(mismatch.errors[0].path, '/a~1b~0c');
});

test('patterns use Unicode mode during schema review and instance validation', () => {
  const schema = {type: 'string', pattern: '^..$'};
  assert.equal(validateSchema(schema, '💡').valid, false);
  assert.equal(validateSchema(schema, 'ab').valid, true);
  assert.throws(() => assertSchemaSupported({pattern: '[\\u{110000}]'}), /invalid Unicode JavaScript regular expression/);
});

test('enum values are valid and structurally unique JSON values', () => {
  assert.throws(() => assertSchemaSupported({enum: [1, 1]}), /enum values must be unique/);
  assert.throws(() => assertSchemaSupported({enum: [{a: 1}, {a: 1}]}), /enum values must be unique/);
  assert.throws(() => assertSchemaSupported({const: Number.NaN}), /const must be a JSON value/);
  assert.equal(validateSchema({enum: [{a: 1}, {a: 2}]}, {a: 2}).valid, true);
  assert.throws(() => assertSchemaSupported({examples: {not: 'an array'}}), /examples must be an array of JSON values/);
  assert.throws(() => assertSchemaSupported({'x-parserOnly': ['ok', 7]}), /x-parserOnly must be an array of strings/);
  assert.throws(() => assertSchemaSupported({'x-builtInTechnologies': [{id: 'missing-name'}]}), /x-builtInTechnologies must be an array of \{id, name\} objects/);
});
