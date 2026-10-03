/** The JSON Schema subset AltCLI's own read replies are declared and checked with. It validates server output before it leaves
 * the host; it is not a general validator and never judges a model's answer. */
export interface Schema {
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  description?: string;
}
const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array'
  : typeof value === 'number' ? Number.isInteger(value) ? 'integer' : 'number' : typeof value;
const allows = (types: string[], actual: string) => types.includes(actual) || (actual === 'integer' && types.includes('number'));
/** The first violation as a JSON path and reason, or null when the value conforms. */
export function violation(schema: Schema, value: unknown, path = '$'): string | null {
  const actual = typeOf(value);
  if (schema.type !== undefined && !allows(typeof schema.type === 'string' ? [schema.type] : schema.type, actual)) return `${path}: expected ${schema.type}, got ${actual}`;
  if (schema.const !== undefined && value !== schema.const) return `${path}: expected ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: not an allowed value`;
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: longer than ${schema.maxLength}`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${path}: does not match ${schema.pattern}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: more than ${schema.maxItems} items`;
    if (schema.items) for (let i = 0; i < value.length; i++) { const found = violation(schema.items, value[i], `${path}[${i}]`); if (found) return found; }
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) return `${path}.${key}: required`;
    for (const [key, item] of Object.entries(object)) {
      const declared = schema.properties?.[key];
      if (declared) { const found = violation(declared, item, `${path}.${key}`); if (found) return found; continue; }
      if (schema.additionalProperties === false) return `${path}.${key}: not declared`;
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const found = violation(schema.additionalProperties, item, `${path}.${key}`); if (found) return found;
      }
    }
  }
  return null;
}
