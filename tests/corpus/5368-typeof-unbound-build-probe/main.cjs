'use strict'

const selected = typeof __BUILD_MARKER__ !== 'undefined' || typeof esbuildDetection !== 'undefined'
  ? 'injected'
  : 'portable'

console.log(typeof __BUILD_MARKER__, typeof esbuildDetection, selected)
