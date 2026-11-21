import { defaultMaxListeners, getMaxListeners, setMaxListeners } from 'node:events'

const signal = AbortSignal.abort()
const initial = getMaxListeners(signal)
setMaxListeners(15, signal)
console.log(defaultMaxListeners, initial, getMaxListeners(signal))
