/**
 * Compress tool descriptions to reduce token usage in router tool listings.
 */
export function compressDescription(desc: string, maxLen: number = 80): string {
  if (desc.length <= maxLen) {
    return desc;
  }

  // Try to cut at sentence boundary (". " before maxLen)
  const searchArea = desc.slice(0, maxLen);
  const sentenceEnd = searchArea.lastIndexOf(". ");
  if (sentenceEnd > 0) {
    return desc.slice(0, sentenceEnd + 1) + "\u2026";
  }

  // Fall back to word boundary
  const lastSpace = searchArea.lastIndexOf(" ");
  if (lastSpace > 0) {
    return desc.slice(0, lastSpace) + "\u2026";
  }

  // No word boundary found, hard truncate
  return desc.slice(0, maxLen) + "\u2026";
}
