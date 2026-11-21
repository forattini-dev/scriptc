interface Tool {
  name: string;
}

const value: { TOOLS: Tool[] | string[] } = { TOOLS: [] };
console.log(value.TOOLS.length);
