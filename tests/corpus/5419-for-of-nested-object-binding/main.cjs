const headers = new Map([
  ['content-type', { name: 'Content-Type', value: 'text/plain' }],
  ['x-test', { name: 'X-Test', value: 'ok' }]
])

const values = []
for (const { 0: lowerName, 1: { name, value } } of headers) {
  values.push(`${lowerName}:${name}:${value}`)
}

console.log(values.join('|'))
