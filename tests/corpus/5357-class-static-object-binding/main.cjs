class State {
  static getState (value) {
    return value
  }

  static setState (value, state) {
    return `${value}:${state}`
  }
}

const { getState, setState } = State
console.log(Reflect.deleteProperty(State, 'getState'), Reflect.deleteProperty(State, 'setState'))

const value = 'first'
console.log(getState(value))
console.log(
  setState(value, 'second'),
  Reflect.get(State, 'getState') === undefined,
  Reflect.get(State, 'setState') === undefined
)
