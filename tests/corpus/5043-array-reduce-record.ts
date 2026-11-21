const result = ['a', 'bb'].reduce((output, key) => {
  output[key] = key.length;
  return output;
}, {} as Record<string, number>);

console.log(result.a, result.bb);
