// @rust-only
// @no-engine
class Fault extends Error { name = 'Fault'; }
function callback(): void { throw new Fault('failure'); }
try { callback(); } catch { console.log('source error'); } finally { console.log('source cleanup'); }
try { new RegExp('['); } catch { console.log('runtime syntax error'); }
let callbackValue: (() => void) | undefined = callback;
function clear(): void { callbackValue = undefined; }
if (callbackValue !== undefined) {
  try { clear(); callbackValue(); } catch { console.log('runtime nullable call'); }
}
try { throw 1; } catch { try { throw 2; } catch { console.log('nested handler'); } }
console.log('done');
