import { spawnSync } from 'node:child_process';

const payload = Buffer.from([0, 255, 65, 10]);
const result = spawnSync('git', ['hash-object', '--stdin'], {
  input: payload,
  encoding: 'buffer',
});
console.log(result.status, Buffer.isBuffer(result.stdout), result.stdout.toString('utf8').trim());
