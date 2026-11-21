'use strict'

const markResourceTiming = performance.markResourceTiming
let effects = 0
markResourceTiming(
  (++effects, { startTime: 0, duration: 0 }),
  (++effects, 'https://example.com'),
  (++effects, 'fetch'),
  (++effects, globalThis),
  (++effects, ''),
  (++effects, {}),
  (++effects, 200)
)
console.log(effects)
