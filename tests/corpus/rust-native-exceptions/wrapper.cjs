var before = exports;
try { throw 'ok'; } catch (exports) { console.log('shadow', exports === 'ok'); }
console.log('wrapper', module.exports === before);
