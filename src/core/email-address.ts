/**
 * Parse an email address into the form admission stores (trimmed, lowercased),
 * or return null when it is not one. Shared by admission and artifact grants so
 * both compare the same text.
 */
export function parseEmailAddress(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized.length < 3 || normalized.length > 320 || !normalized.includes("@")) {
    return null;
  }
  return normalized;
}
