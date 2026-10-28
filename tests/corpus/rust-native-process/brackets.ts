import { stdout, stderr, stdin } from 'node:process';

console.log('out', process['stdout']['isTTY'] === process.stdout.isTTY);
console.log('err', stderr['isTTY'] === process.stderr.isTTY);
console.log('in', stdin['isTTY'] === process.stdin.isTTY);
console.log('import', stdout['isTTY'] === process.stdout.isTTY);

function observe(process: { stdout: { isTTY: boolean } }): boolean {
  return process['stdout']['isTTY'];
}
console.log('shadow', observe({ stdout: { isTTY: false } }), observe({ stdout: { isTTY: true } }));
