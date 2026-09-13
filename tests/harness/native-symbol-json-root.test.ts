/* Symbol roots need an undefined result, which the current JSON expression
 * ABI cannot represent. This tests explicit refusal, not Node parity. */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compile } from '@scriptc/compiler';

const execFileAsync = promisify(execFile);
const sanitize = process.env['SCRIPTC_SAN'] === '1';
describe.skipIf(sanitize)('native Symbol root JSON boundary', () => {
  let directory: string | undefined;
  let binary: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'scriptc-symbol-json-root-'));
    const result = await compile(join(import.meta.dirname, '../fixtures/native-symbol-json-root/main.ts'), {
      backend: 'rust', allowEngine: false, optimization: 'dev', outDir: directory, outPath: join(directory, 'program'),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.execution.engine).toBe('none');
    expect(result.runtimeFences).toEqual([]);
    binary = result.binaryPath;
  });
  afterAll(() => { if (directory !== undefined) rmSync(directory, { recursive: true, force: true }); });
  test.each(['root', 'root-indent', 'identity-replacer', 'returned-symbol'])('%s refuses without returning the string undefined', async mode => {
    const result = await execFileAsync(binary, [mode], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: '1' },
    }).then(() => { throw new Error('native Symbol root unexpectedly succeeded'); }, error => error as { code: unknown; stdout: string; stderr: string });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Uncaught Error: scriptc: JSON.stringify of a native Symbol root is not supported yet (requires an undefined result)\n');
  });
});
