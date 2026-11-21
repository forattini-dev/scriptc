const WrapHandler = require('./wrap-handler.cjs')

const wrapInterceptor = (dispatch) => (handler) =>
  dispatch(WrapHandler.wrap(handler))

const input = { ready: false }
const seen = wrapInterceptor((value) => value)(input)
console.log(seen === input, seen.handler === input, seen.handler.ready)
