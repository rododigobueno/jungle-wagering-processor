import { createHash } from 'node:crypto';

export function createPayloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;

    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
      );

    return `{${entries.join(',')}}`;
  }

  throw new Error('Unsupported payload value');
}