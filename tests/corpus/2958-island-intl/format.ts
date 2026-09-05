// The island module (Proxy has no static lowering): Intl members the
// engine must provide — number formatting, plural categories, grapheme
// segmentation, list formatting, collation.
const cache = new Proxy({ hits: 0 }, {});
export function money(n: number): string {
  (cache as { hits: number }).hits += 1;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
export function grouped(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
export function plural(n: number): string {
  return new Intl.PluralRules("en-US").select(n);
}
export function graphemes(s: string): number {
  let count = 0;
  for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)) count += 1;
  return count;
}
export function list(items: string[]): string {
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);
}
export function sorted(items: string[]): string[] {
  const collator = new Intl.Collator("en");
  return [...items].sort((a, b) => collator.compare(a, b));
}
