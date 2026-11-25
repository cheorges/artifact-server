/** The first eight characters of an id, without a version id's `ver_` prefix. */
export function compactId(value: string): string {
  const unprefixed = value.startsWith("ver_") ? value.slice(4) : value;
  return unprefixed.slice(0, 8);
}
