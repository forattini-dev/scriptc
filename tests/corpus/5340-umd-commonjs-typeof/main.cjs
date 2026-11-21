// @rust-only
// @no-engine
;(function(root) {
  var freeExports = typeof exports == 'object' && exports;
  var freeModule = typeof module == 'object' && module &&
    module.exports == freeExports && module;
  var freeGlobal = typeof global == 'object' && global;
  if (freeModule) {
    freeModule.exports = { ok: true };
  }
  var amd = false;
  if (
    typeof define == 'function' &&
    typeof define.amd == 'object' &&
    define.amd
  ) {
    define(function() { return 'amd'; });
    amd = true;
  }
  console.log(Boolean(freeExports), Boolean(freeModule), Boolean(freeGlobal), typeof root, amd, freeModule.exports.ok);
}(this));
