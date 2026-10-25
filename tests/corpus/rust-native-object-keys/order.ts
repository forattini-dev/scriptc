// @rust-only
// @no-engine
// @ts-nocheck
let trace = '';
const data: { before: number; after?: number } = { before: 1 };
function input() { trace = trace + 'i'; return data; }
function extra(): number { trace = trace + 'e'; data.after = 2; return 1; }
console.log('keys', Object.keys(input(), extra()).join('|'), trace);
trace = '';
function fail(): number { trace = trace + 'x'; throw new Error('extra'); }
try { Object.keys(null, fail()); } catch (error) { console.log('extra error', (error as Error).message, trace); }
trace = '';
function nullish(): number | undefined { trace = trace + 'n'; return undefined; }
function ignored() { trace = trace + 'e'; return 'ignored'; }
try { Object.keys(nullish(), ignored()); } catch (error) { console.log('nullish', (error as Error).name, (error as Error).message, trace); }
function rejected(value: unknown): void {
  try { Object.keys(value); } catch (error) { console.log('error', (error as Error).name, (error as Error).message); }
}
rejected(null); rejected(undefined);
try { Object.keys(); } catch (error) { console.log('missing', (error as Error).name, (error as Error).message); }
function noValue() { trace = trace + 'v'; }
try { Object.keys(noValue()); } catch (error) { console.log('void', (error as Error).message, trace); }
export {};
