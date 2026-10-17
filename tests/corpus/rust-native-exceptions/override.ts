// @rust-only
// @no-engine
function masked(): number { try { throw 1; } finally { return 9; } }
function replaced(): number {
  try { try { return 2; } finally { throw false; } } catch { return 4; }
}
function fromCatch(): number {
  try { try { throw null; } catch { return 3; } finally { throw undefined; } }
  catch { return 5; }
}
console.log('completions', masked(), replaced(), fromCatch());
try { try { throw 1; } finally { throw 2; } } catch { console.log('replaced throw'); }
try { try { throw 1; } catch { throw 2; } } catch { console.log('catch throws'); }
