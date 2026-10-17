var first = require('./cache-source.js');
first.replace();
var second = require('./cache-source.js');
console.log("cache", first === second, first.value === 7, second.value === 99);
