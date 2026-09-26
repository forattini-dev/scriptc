for (const value of [-100n, 0n, 100n, 123456789012345678901234567890n]) {
  console.log(value.toString(), value.toString(undefined));
}
function printRadix(radix?: number): void {
  console.log((255n).toString(radix));
}
printRadix();
printRadix(16);
let effects = 0;
console.log((255n).toString(void effects++), effects);
