function prefix(values: string[]): string[] {
  return ['x', values[1]!];
}
function spread(values: string[]): string[] {
  return [...['x'], values[1]!];
}
function processPrefix(): string[] {
  return [process.execPath, process.argv[999]!];
}
for (const result of [prefix([]), prefix(['a']), prefix(['a', 'b']), spread([]), processPrefix()]) {
  console.log(typeof result[1]);
  console.log(Object.hasOwn(result, 1));
  console.log(result.slice(1).join('|'));
}
