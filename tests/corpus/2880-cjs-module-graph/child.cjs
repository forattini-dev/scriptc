'use strict';

/** @type {ScriptcModule | null | undefined} */
const parent = module.parent;
/** @type {ScriptcModule | undefined} */
const selfCached = require.cache[__filename];
console.log(
  'child-init',
  module.id === __filename,
  module.filename === __filename,
  module.path === __dirname,
  module.paths[0].endsWith('/node_modules'),
  module.loaded,
  module.isPreloading,
  parent ? parent.filename.endsWith('main.cjs') : false,
  selfCached === module,
);

const leaf = require('./leaf.cjs');
module.exports = { value: leaf.value + 2 };
