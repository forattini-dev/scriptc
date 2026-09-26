'use strict';

/** @type {ScriptcModule | undefined} */
const mainCached = require.cache[__filename];

console.log(
  'main',
  module.id === '.' || module.id === __filename,
  module.filename === __filename,
  module.path === __dirname,
  module.loaded,
  module.isPreloading,
  typeof module === 'object',
  require.main === module,
  mainCached === module,
);

const child = require('./child.cjs');
const childPath = require.resolve('./child.cjs');
/** @type {ScriptcModule | undefined} */
const cachedChild = require.cache[childPath];
if (cachedChild) {
  console.log(
    'child-after',
    child.value,
    cachedChild.loaded,
    cachedChild.id === childPath,
    cachedChild.path === __dirname,
    cachedChild.parent === module,
  );
}

require('./child.cjs');
/** @type {ScriptcModule[]} */
const children = module.children;
console.log(
  'children',
  children.length,
  children[0].filename === childPath,
  children.map((entry) => entry.filename.slice(entry.path.length + 1)).join(','),
);

const cacheNames = Object.keys(require.cache).map((entry) => entry.slice(__dirname.length + 1));
console.log('cache', cacheNames.join(','), childPath in require.cache);

for (let attempt = 0; attempt < 2; attempt++) {
  try {
    require('./failed.cjs');
  } catch (error) {
    console.log('failed', attempt, error instanceof Error, String(error));
  }
}
const failedPath = require.resolve('./failed.cjs');
/** @type {ScriptcModule | undefined} */
const failedCached = require.cache[failedPath];
console.log('evicted', failedCached === undefined, !(failedPath in require.cache));

process.on('exit', () => {
  console.log('exit-loaded', module.loaded);
});
