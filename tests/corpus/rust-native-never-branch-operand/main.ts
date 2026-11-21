interface Ctx { metaRobots?: string[] }

function indexable(ctx: Ctx): string {
  if (ctx.metaRobots === undefined) {
    return "unknown";
  }
  // After the guard the false branch is unreachable (`never`).
  const robots = Array.isArray(ctx.metaRobots) ? ctx.metaRobots : [ctx.metaRobots];
  const blocked = robots.some((r) => r.toLowerCase().includes("noindex") || r.toLowerCase().includes("none"));
  return blocked ? "blocked" : `indexable (${robots.length})`;
}

for (const ctx of [{}, { metaRobots: ["index", "follow"] }, { metaRobots: ["NOINDEX"] }] as Ctx[]) {
  console.log(indexable(ctx));
}
