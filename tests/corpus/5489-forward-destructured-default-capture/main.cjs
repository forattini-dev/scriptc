function outer(input) {
  const { data: { data } } = input
  let aborted = false
  let calls = 0
  return handleReply()

  function handleReply(value = data) {
    if (aborted) return 'bad'
    calls++
    return resume(value + calls)
  }

  function resume(value) { return value }
}

console.log(outer({ data: { data: 'ok' } }))
