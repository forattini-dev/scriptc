import { createHash } from 'node:crypto';

const digest = createHash('sha256')
  .update('prefix\0')
  .update(Buffer.from([0, 255, 7]))
  .update('\0suffix')
  .digest('hex');

console.log(digest);
