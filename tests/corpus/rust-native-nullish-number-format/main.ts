interface Ctx { wordCount?: number; subheadingFrequency?: number }
const rules: { check: (ctx: Ctx) => string | null }[] = [{
  check: (ctx) => {
    if (ctx.wordCount && ctx.wordCount > 300 && (ctx.subheadingFrequency ?? 0) < 0.5) {
      return `Low (${(ctx.subheadingFrequency ?? 0).toFixed(2)} per 100 words)`;
    }
    return null;
  },
}];
for (const ctx of [{ wordCount: 400, subheadingFrequency: 0.25 }, { wordCount: 400 }, { wordCount: 10 }] as Ctx[]) {
  console.log(rules[0].check(ctx));
}
