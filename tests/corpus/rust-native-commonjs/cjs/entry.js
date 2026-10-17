var first = require('./first.js');
var second = require('./leaf.js');
console.log(first.leaf === second, second.twice(3) === 6);
