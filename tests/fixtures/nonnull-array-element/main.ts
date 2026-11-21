function report(value: any): void {
  console.log(typeof value);
  console.log(value === undefined);
  console.log(String(value));
  console.log(value);
}
const empty: string[] = [];
const zero = 'a'.split(' ', 0)[0]!;
const missing = empty[0]!;
const optionalValues: (string | undefined)[] = [undefined];
const optional = optionalValues[0]!;
const word = ['hello'][0]!;
const number = [42][0]!;
const flag = [false][0]!;
const normal = 'a b'.split(' ')[0]!;
const blank = ''.split(' ')[0]!;
report(zero); report(missing); report(optional); report(word);
report(number); report(flag); report(normal); report(blank);
function typedConsumers(): void {
  const text = ['hi'][0]!;
  const n = [2][0]!;
  console.log(text.toUpperCase());
  console.log(n + 3);
}
typedConsumers();
try { console.log(missing.toUpperCase()); }
catch (error) { console.log(error instanceof TypeError); }
console.log(missing + '!');
const missingNumbers: number[] = [];
const missingNumber = missingNumbers[0]!;
console.log(missingNumber + 3);
