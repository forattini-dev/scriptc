/** @type {Record<string, () => any>} */
const lazyLoaders = {
  __proto__: null,
  'node:crypto': () => require('node:crypto'),
  'node:sqlite': () => require('node:sqlite'),
  'node:worker_threads': () => require('node:worker_threads'),
  'node:zlib': () => require('node:zlib')
}

console.log('node:crypto', typeof lazyLoaders['node:crypto']())
console.log('node:sqlite', typeof lazyLoaders['node:sqlite']())
console.log('node:worker_threads', typeof lazyLoaders['node:worker_threads']())
console.log('node:zlib', typeof lazyLoaders['node:zlib']())
console.log(typeof lazyLoaders['node:crypto']().randomUUID)
