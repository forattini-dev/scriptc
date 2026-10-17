// @rust-only
// @no-engine
function guarded(mode: number): number {
  console.log('start', mode);
  try { if (mode === 1) throw 'body'; return 2; }
  catch { console.log('caught', mode); return 3; }
  finally { console.log('finally', mode); if (mode === 2) return 4; }
}
console.log('result', guarded(0), guarded(1), guarded(2));
function nested(): number {
  try { try { return 7; } finally { console.log('inner'); } }
  finally { console.log('outer'); }
}
console.log('nested result', nested());
