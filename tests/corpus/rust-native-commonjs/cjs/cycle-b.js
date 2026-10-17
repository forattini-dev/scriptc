var a = require('./cycle-a.js');
exports.saw = a.phase;
exports.a = a;
