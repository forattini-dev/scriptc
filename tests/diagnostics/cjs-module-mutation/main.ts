'use strict';

module.loaded = true;
module.id = 'replacement';
module.paths[0] = '/tmp/node_modules';
module.paths.push('/tmp/node_modules');
require.cache[__filename] = module;
delete require.cache[__filename];
