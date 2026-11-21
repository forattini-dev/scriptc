let evaluated = 0
const encoder = new TextEncoder((evaluated++, 'utf-8'), evaluated++)
const decoder = new TextDecoder()

console.log(evaluated, decoder.decode(encoder.encode('ok')))
