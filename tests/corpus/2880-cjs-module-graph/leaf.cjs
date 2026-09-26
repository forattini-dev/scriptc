'use strict';

/** @type {ScriptcModule | null | undefined} */
const parent = module.parent;
console.log(
  'leaf-init',
  module.loaded,
  parent ? parent.filename.endsWith('child.cjs') : false,
  require.main === parent,
);

module.exports = { value: 40 };
