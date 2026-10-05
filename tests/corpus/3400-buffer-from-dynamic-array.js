// @rust-only
// @no-engine
function copy(value) { return Buffer.from(value).toString('hex'); }
const values = JSON.parse('[257,-1,3.9,true,null,"258","bad",[],[5]]');
values.push(undefined, NaN, Infinity);
console.log(copy(values));
console.log(copy(JSON.parse('[]')));
try { copy([1n]); } catch (error) { console.log(error.name, error.message); }
try { copy([Symbol('byte')]); } catch (error) { console.log(error.name, error.message); }
