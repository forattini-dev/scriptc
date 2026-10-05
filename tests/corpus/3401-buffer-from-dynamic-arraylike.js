// @rust-only
// @no-engine
function copy(value) { return Buffer.from(value).toString('hex'); }
console.log(copy(JSON.parse('{"0":257,"1":-1,"3":5,"length":4}')));
console.log(copy(JSON.parse('{"0":7,"1":8,"length":1.9}')));
console.log(copy(JSON.parse('{"length":-2}')));
console.log(copy(JSON.parse('{"length":"2","0":9}')));
console.log(copy(JSON.parse('{"type":"Buffer","data":[259,5,7]}')));
console.log(copy({ length: NaN }));
try { copy({ length: Infinity }); } catch (error) { console.log(error.name, error.message); }
