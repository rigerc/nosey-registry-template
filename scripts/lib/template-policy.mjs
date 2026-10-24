function yamlScalarValue(source) {
  let value = '';
  let quote = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote === "'" && character === "'" && source[index + 1] === "'") {
      value += "''";
      index++;
      continue;
    }
    if (quote === '"' && character === '\\') {
      value += character + (source[++index] ?? '');
      continue;
    }
    if (quote && character === quote) quote = null;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (!quote && character === '#' && (index === 0 || /\s/.test(source[index - 1]))) break;
    value += character;
  }

  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === "'" || trimmed[0] === '"') && trimmed.at(-1) === trimmed[0]) {
    return trimmed[0] === "'" ? trimmed.slice(1, -1).replaceAll("''", "'") : trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return trimmed;
}

// Parse the bounded GitHub Actions `uses` scalar form without implementing YAML.
export function actionReferences(source) {
  return [...source.matchAll(/^\s*-?\s*uses\s*:\s*(.*?)\s*$/gm)].map((match) => yamlScalarValue(match[1]));
}

export function isPinnedActionReference(action) {
  return /^[^@]+@[0-9a-f]{40}$/i.test(action);
}
