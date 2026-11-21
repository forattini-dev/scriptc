async function selected(enabled: boolean): Promise<string> {
  const { TOOLS } = enabled
    ? await import("./5160-conditional-dynamic-import-lib.ts")
    : { TOOLS: [] };
  return TOOLS.filter(tool => tool.name.length > 0).map(tool => tool.name).join(",");
}

selected(true).then(value => console.log(value));
