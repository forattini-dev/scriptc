interface ValueView {
  value: number
  clone(): ValueView
}

class ValueWrapper implements ValueView {
  value: number
  constructor(value: number) {
    this.value = value
  }
  clone(): ValueView {
    return new ValueWrapper(this.value)
  }
}

async function dispatch(): Promise<ValueView> {
  return new ValueWrapper(1)
}

void dispatch().then(value => {
  const clone = value.clone()
  clone.value++
  console.log(value.value, clone.value, value === clone)
})
