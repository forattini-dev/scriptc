/* Native-only contracts: opaque Effect references preserve identity but do
 * not yet expose JavaScript reflection. These are explicit refusals, not
 * differential programs that would incorrectly bless changed Node behavior. */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compile } from '@scriptc/compiler';

const execFileAsync = promisify(execFile);
const entry = join(import.meta.dirname, '../fixtures/native-effect-reflection/main.ts');
const sanitize = process.env['SCRIPTC_SAN'] === '1';

interface RunResult { stdout: string; stderr: string; exitCode: number }

async function run(binary: string, mode: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, [mode], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: '1' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof result.code !== 'number' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw error;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }
}

// Rust sanitizer builds remain unsupported, as in rust-differential.test.ts.
// Plain execution enables the Rust heap audit for every refusal/unwind path.
describe.skipIf(sanitize)('native Effect reflection boundaries', () => {
  let directory: string | undefined;
  let binary: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'scriptc-effect-reflection-'));
    const result = await compile(entry, {
      outPath: join(directory, 'program'), outDir: directory,
      backend: 'rust', optimization: 'dev', allowEngine: false,
    });
    if (!result.ok) throw new Error('Native Effect refusal fixture failed to compile:\n' +
      result.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n'));
    expect(result.backend).toBe('rust');
    expect(result.execution.engine).toBe('none');
    expect(result.runtimeFences).toEqual([]);
    binary = result.binaryPath;
  });

  afterAll(() => { if (directory !== undefined) rmSync(directory, { recursive: true, force: true }); });

  const cases = [
    ['json-root-replacer', 'JSON.stringify toJSON preparation', ''],
    ['json-nested-replacer', 'JSON.stringify toJSON preparation', 'root-replacer\n'],
    ['assign-source', 'Object.assign or object spread', ''],
    ['assign-target', 'Object.assign or object spread', ''],
    ['has-own', 'own property membership', ''],
    ['in-literal', 'property membership', ''],
    ['in-computed', 'property membership', ''],
  ] as const;

  test.each(cases)('%s refuses without fabricating a result', async (mode, operation, stdout) => {
    const result = await run(binary, mode);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe(`Uncaught Error: scriptc: ${operation} on native kernel references is not supported yet\n`);
    expect(result.stderr).not.toContain('Rust heap object(s) still live');
  });
});
