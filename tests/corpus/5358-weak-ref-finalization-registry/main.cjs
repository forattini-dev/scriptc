const target = { value: 7 }
const weak = new WeakRef(target)
const registry = new FinalizationRegistry(() => {
  console.log('finalized')
})

registry.register(target, 'held')
console.log(weak.deref() === target)
console.log(registry.unregister({}))
