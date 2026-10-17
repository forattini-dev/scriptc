console.log("mutate:init");
const data = require('./data.json');
data.nested.answer = 51;
exports.data = data;
