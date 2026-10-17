var data = require('./data.json');
function read() { return data; }
exports.read = read;

var numbers = require("./numbers-only.json");
exports.numbers = numbers;
