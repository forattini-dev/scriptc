async function main(): Promise<void> {
  const moduleName = 'node:path';
  console.log('before import');
  const path = await import(moduleName);
  console.log('basename', path.basename(path.join('alpha', 'beta.txt')));
  {
    const moduleName = `node:os`;
    const second = await import(moduleName);
    console.log('nested', second.platform());
  }
  const aliasName = `path`;
  const alias = await import(aliasName);
  console.log('alias', alias.basename('x/y'));
  const zlibModuleName = 'node:zlib';
  const zlib = await import(zlibModuleName);
  const compressed: Uint8Array = zlib.gzipSync(new Uint8Array([65, 66]));
  console.log('gzip', compressed.length);
  console.log('done');
}
console.log('start');
void main();
console.log('scheduled');
