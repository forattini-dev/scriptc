// @rust-only
// @no-engine
function text(): void { throw 'hello'; }
try { text(); } catch (error) {
  if (typeof error === 'string') console.log('string', error);
}
try { throw 4; } catch (error) {
  if (typeof error === 'number') console.log('number', error + 1);
}
try { throw false; } catch (error) { console.log('boolean', error === false); }
class Fault extends Error { name = 'Fault'; }
try { throw new Fault('boom'); } catch (error) {
  console.log('hierarchy', error instanceof Fault, error instanceof Error, error instanceof TypeError);
  if (error instanceof Error) console.log('fields', error.name, error.message);
}
try { new RegExp('['); } catch (error) {
  console.log('runtime hierarchy', error instanceof SyntaxError, error instanceof Error, error instanceof TypeError);
}
try { try { throw 'again'; } catch (error) { throw error; } }
catch (error) { console.log('rethrow', error === 'again'); }
function deferred(): () => unknown {
  try { throw 42; } catch (error) { return () => error; }
}
console.log('escaped', deferred()() === 42);
