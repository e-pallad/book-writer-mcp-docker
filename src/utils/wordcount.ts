export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

export function estimateReadingTime(wordCount: number): number {
  return Math.ceil(wordCount / 250);
}
