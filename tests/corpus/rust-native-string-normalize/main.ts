function slugify(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

console.log(slugify("Olá, Ação Rápida!"), slugify("  Crème Brûlée  "), slugify(undefined));
const composed = "e\u0301";
console.log(composed.length, composed.normalize().length, composed.normalize("NFC") === "\u00e9");
console.log("\u00e9".normalize("NFD").length, "\ufb01".normalize("NFKC"));
try {
  "x".normalize("bogus");
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message);
}
