function collect(argv: string[]) {
  const names = new Map<string, string>();
  names.set('name', 'canonical');
  names.set('n', 'canonical');
  const found: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/) ?? arg.match(/^-([^=])(?:=(.*))?$/);
    if (match === null) continue;
    const canonical = names.get(match[1]!);
    if (canonical !== undefined) found.push(canonical);
  }
  return found.join(',');
}
const argv = ['--name=one', '--name', '-n=one', '-n', '--=x', '', '-x', '--unknown'];
for (let round = 0; round < 4; round++) console.log(round, collect(argv));
const optional = ''.match(/^(a)?$/);
if (optional !== null) {
  const names = new Map<string, string>();
  names.set('a', 'present');
  console.log('absent', JSON.stringify(names.get(optional[1]!)), names.has(optional[1]!), names.delete(optional[1]!));
}
