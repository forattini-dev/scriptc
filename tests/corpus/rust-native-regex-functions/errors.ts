// @rust-only
// @no-engine
// @ts-nocheck
const regex = /undefined/;
const test = regex.test;
try { test("undefined"); } catch (error) { console.log(error instanceof TypeError); }
try { test.call(null, "a"); } catch (error) { console.log(error instanceof TypeError); }
try { test.call({}, "a"); } catch (error) { console.log(error instanceof TypeError); }
try { test.call("a", "a"); } catch (error) { console.log(error instanceof TypeError); }
console.log(test.call(regex), test.bind(regex)());
console.log(test.call(/42/, 42), test.call(/true/, true), test.call(/null/, null));
try { test.call(regex, Symbol("a")); } catch (error) { console.log(error instanceof TypeError); }
