// A deliberately bounded evaluator for the JSON Schema vocabulary used by Nosey.
// Schemas are data: references are resolved only within their owning document.

const ANNOTATIONS = new Set([
  '$id', '$schema', 'title', 'description', 'examples', '$comment', 'default',
  'deprecated', 'readOnly', 'writeOnly', 'x-parserOnly', 'x-normalization',
  'x-builtInTechnologies', 'x-builtInCombinations',
]);
const KEYWORDS = new Set([
  '$ref', '$defs', 'type', 'required', 'properties', 'propertyNames',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength',
  'maxLength', 'minProperties', 'maxProperties', 'pattern', 'enum', 'const',
  'allOf', 'anyOf', 'not', 'if', 'then', 'else', 'dependentSchemas',
]);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

function schemaError(path, message) {
  throw new TypeError(`Invalid schema at ${path || '<root>'}: ${message}`);
}
function pointer(path, part) {
  return `${path}/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validateAnnotation(key, value, path) {
  const invalid = (expected) => schemaError(path, `${key} must be ${expected}`);
  switch (key) {
    case '$id': case '$schema': case 'title': case 'description': case '$comment': case 'x-normalization':
      if (typeof value !== 'string') invalid('a string');
      break;
    case 'deprecated': case 'readOnly': case 'writeOnly':
      if (typeof value !== 'boolean') invalid('a boolean');
      break;
    case 'examples':
      if (!Array.isArray(value) || !value.every((item) => isJsonValue(item))) invalid('an array of JSON values');
      break;
    case 'default':
      if (!isJsonValue(value)) invalid('a JSON value');
      break;
    case 'x-parserOnly':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalid('an array of strings');
      break;
    case 'x-builtInTechnologies': case 'x-builtInCombinations':
      if (!Array.isArray(value) || value.some((item) => !isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name)) invalid('an array of {id, name} objects');
      break;
  }
}

function decodePointer(ref, path) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) schemaError(path, '$ref must be a local JSON Pointer');
  if (ref === '#') return [];
  if (!ref.startsWith('#/')) schemaError(path, '$ref must be a local JSON Pointer fragment');
  return ref.slice(2).split('/').map((part) => {
    if (/~(?![01])/.test(part)) schemaError(path, `invalid JSON Pointer escape in $ref ${ref}`);
    return part.replaceAll('~1', '/').replaceAll('~0', '~');
  });
}

function resolveRef(root, ref, path) {
  let target = root;
  for (const part of decodePointer(ref, path)) {
    if ((Array.isArray(target) && /^(0|[1-9]\d*)$/.test(part)) || isRecord(target)) {
      if (!Object.hasOwn(target, part)) schemaError(path, `dangling $ref ${ref}`);
      target = target[part];
    } else schemaError(path, `invalid $ref target ${ref}`);
  }
  if (!(typeof target === 'boolean' || isRecord(target))) schemaError(path, `$ref ${ref} does not target a schema`);
  return target;
}

function prewalk(root) {
  const seen = new WeakSet();
  const active = new WeakSet();
  function visit(schema, path) {
    if (typeof schema === 'boolean') return;
    if (!isRecord(schema)) schemaError(path, 'schema must be an object or boolean');
    if (active.has(schema)) schemaError(path, 'unsupported cyclic schema reference');
    if (seen.has(schema)) return;
    seen.add(schema);
    active.add(schema);
    for (const [key, value] of Object.entries(schema)) {
      if (ANNOTATIONS.has(key)) { validateAnnotation(key, value, pointer(path, key)); continue; }
      if (!KEYWORDS.has(key)) schemaError(pointer(path, key), `unsupported keyword ${key}`);
      const child = (v, p) => visit(v, p);
      switch (key) {
        case '$ref': visit(resolveRef(root, value, pointer(path, key)), pointer(path, key)); break;
        case '$defs': case 'properties': case 'dependentSchemas':
          if (!isRecord(value)) schemaError(pointer(path, key), `${key} must be an object`);
          for (const [name, sub] of Object.entries(value)) child(sub, pointer(pointer(path, key), name));
          break;
        case 'type': {
          const types = Array.isArray(value) ? value : [value];
          if (!types.length || types.some((type) => !TYPES.has(type)) || new Set(types).size !== types.length) schemaError(pointer(path, key), 'type must name valid, unique JSON types');
          break;
        }
        case 'required':
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length) schemaError(pointer(path, key), 'required must be an array of unique strings');
          break;
        case 'propertyNames': case 'additionalProperties': case 'items': case 'not': case 'if': case 'then': case 'else': child(value, pointer(path, key)); break;
        case 'allOf': case 'anyOf':
          if (!Array.isArray(value) || value.length === 0) schemaError(pointer(path, key), `${key} must be a non-empty array`);
          value.forEach((sub, i) => child(sub, pointer(pointer(path, key), i)));
          break;
        case 'minItems': case 'maxItems': case 'minLength': case 'maxLength': case 'minProperties': case 'maxProperties':
          if (!Number.isSafeInteger(value) || value < 0) schemaError(pointer(path, key), `${key} must be a non-negative safe integer`);
          break;
        case 'pattern':
          if (typeof value !== 'string') schemaError(pointer(path, key), 'pattern must be a string');
          // Draft 2020-12 patterns are Unicode-aware. The `u` flag changes
          // quantifier behavior for astral code points (e.g. ^..$ must not
          // match a single emoji).
          try { new RegExp(value, 'u'); } catch (error) { schemaError(pointer(path, key), `invalid Unicode JavaScript regular expression: ${error.message}`); }
          break;
        case 'enum':
          if (!Array.isArray(value) || value.length === 0) schemaError(pointer(path, key), 'enum must be a non-empty array');
          if (value.some((item) => !isJsonValue(item))) schemaError(pointer(path, key), 'enum values must be JSON values');
          if (value.some((item, index) => value.slice(0, index).some((prior) => jsonEqual(prior, item)))) schemaError(pointer(path, key), 'enum values must be unique');
          break;
        case 'const':
          if (!isJsonValue(value)) schemaError(pointer(path, key), 'const must be a JSON value');
          break;
      }
    }
    active.delete(schema);
  }
  visit(root, '');
}

function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === 'number') return Number.isFinite(a) && Number.isFinite(b) && a === b;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a); const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}
function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const result = value.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const result = Object.values(value).every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  return false;
}
function typeMatches(type, data) {
  switch (type) {
    case 'null': return data === null;
    case 'boolean': return typeof data === 'boolean';
    case 'object': return isRecord(data);
    case 'array': return Array.isArray(data);
    case 'number': return typeof data === 'number' && Number.isFinite(data);
    case 'integer': return typeof data === 'number' && Number.isFinite(data) && Number.isInteger(data);
    case 'string': return typeof data === 'string';
  }
}
function valid(schema, data, root, dataPath, refStack = []) {
  if (schema === true) return {valid: true, errors: []};
  if (schema === false) return {valid: false, errors: [{path: dataPath, keyword: 'falseSchema', message: 'boolean schema is false'}]};
  const errors = [];
  const add = (keyword, message, at = dataPath) => errors.push({path: at, keyword, message});
  const check = (sub, value, at = dataPath) => valid(sub, value, root, at, refStack);
  if (Object.hasOwn(schema, '$ref')) {
    const ref = schema.$ref;
    if (refStack.includes(ref)) schemaError(dataPath, `unsupported cyclic $ref ${ref}`);
    const target = resolveRef(root, ref, dataPath);
    const result = valid(target, data, root, dataPath, [...refStack, ref]);
    errors.push(...result.errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, data))) add('type', `must be ${types.join(' or ')}`);
  }
  if (schema.const !== undefined && !jsonEqual(data, schema.const)) add('const', 'must equal the schema constant');
  if (schema.enum !== undefined && !schema.enum.some((value) => jsonEqual(data, value))) add('enum', 'must equal one of the allowed values');
  if (typeof data === 'string') {
    const length = [...data].length;
    if (schema.minLength !== undefined && length < schema.minLength) add('minLength', `must contain at least ${schema.minLength} Unicode code points`);
    if (schema.maxLength !== undefined && length > schema.maxLength) add('maxLength', `must contain at most ${schema.maxLength} Unicode code points`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(data)) add('pattern', `must match ${schema.pattern}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) add('minItems', `must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) add('maxItems', `must contain at most ${schema.maxItems} items`);
    if (schema.items !== undefined) data.forEach((item, index) => errors.push(...check(schema.items, item, pointer(dataPath, index)).errors));
  }
  if (isRecord(data)) {
    const keys = Object.keys(data);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) add('minProperties', `must have at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) add('maxProperties', `must have at most ${schema.maxProperties} properties`);
    for (const name of schema.required ?? []) if (!Object.hasOwn(data, name)) add('required', `must have required property ${JSON.stringify(name)}`);
    if (schema.propertyNames !== undefined) for (const name of keys) errors.push(...check(schema.propertyNames, name, pointer(dataPath, name)).errors);
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(data, name)) errors.push(...check(sub, data[name], pointer(dataPath, name)).errors);
    }
    if (schema.additionalProperties !== undefined) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const name of keys) if (!known.has(name)) {
        if (schema.additionalProperties === false) add('additionalProperties', `must not include additional property ${JSON.stringify(name)}`);
        else errors.push(...check(schema.additionalProperties, data[name], pointer(dataPath, name)).errors);
      }
    }
    for (const [name, sub] of Object.entries(schema.dependentSchemas ?? {})) if (Object.hasOwn(data, name)) errors.push(...check(sub, data).errors);
  }
  for (const sub of schema.allOf ?? []) errors.push(...check(sub, data).errors);
  if (schema.anyOf && !schema.anyOf.some((sub) => check(sub, data).valid)) add('anyOf', 'must match at least one subschema');
  if (schema.not && check(schema.not, data).valid) add('not', 'must not match the negated schema');
  if (schema.if !== undefined) {
    const condition = check(schema.if, data).valid;
    const branch = condition ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...check(branch, data).errors);
  }
  return {valid: errors.length === 0, errors};
}

export function assertSchemaSupported(schema) {
  prewalk(schema);
}

export function validateSchema(schema, data) {
  assertSchemaSupported(schema);
  const result = valid(schema, data, schema, '');
  return {valid: result.valid, errors: result.errors};
}
