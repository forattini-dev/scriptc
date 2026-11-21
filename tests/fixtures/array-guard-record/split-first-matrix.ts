const inputs = ['', 'alpha', 'alpha beta', ' a', 'a ', 'a  b', '🦊 x', '  '];
function first(value: string) { return value.split(' ')[0]!; }
for (let round = 0; round < 4; round++) {
  for (const input of inputs) console.log(round, JSON.stringify(input), JSON.stringify(first(input)));
}
console.log('mapped', JSON.stringify(inputs.map((item) => item.split(' ')[0]!)));
