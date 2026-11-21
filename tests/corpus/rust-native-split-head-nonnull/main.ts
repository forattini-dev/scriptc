async function cmdAgents(): Promise<number> {
  const { checkbox } = await import("./ui.ts");
  const labels = ["claude — Claude Code", "codex — Codex", "", "solo"];
  const picked = await checkbox("Which agents?", labels as [string, ...string[]]);
  if (picked.length === 0) return 0;
  const keys = picked.map((l) => l.split(" ")[0]!);
  console.log(keys.join("|"), keys.length);
  const heads = ["a-b", "", "-x"].map((value) => value.split("-")[0]!.length);
  console.log(heads.join(","));
  return keys.length;
}

cmdAgents().then((code) => console.log("code", code));
