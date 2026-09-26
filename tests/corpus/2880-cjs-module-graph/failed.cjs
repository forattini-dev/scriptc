'use strict';

console.log('failed-init', module.loaded, require.cache[__filename] === module);
throw new Error('boom');
