function markers(source: string): string {
  const begin = "# begin";
  const end = "# end";
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const first = lines.findIndex((line) => line.trim() === begin);
  const last = lines.findIndex((line, index) => index > first && line.trim() === end);
  return `${first}:${last}:${lines.slice(first + 1, last).join("")}`;
}

console.log(markers("head\n# begin\nbody\n# end\ntail\n"));
