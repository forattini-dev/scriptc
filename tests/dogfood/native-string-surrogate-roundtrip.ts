// Native-trust regression probe; also covered by corpus 3113.
// The TOON parseQuotedString reader uses this same indexed append pattern.
// Node and the UTF-16-preserving Rust runtime: true "😀".
const input: string = '😀';
let output = '';
for (let index = 0; index < input.length; index++) output += input[index];
console.log(input === output, JSON.stringify(output));
