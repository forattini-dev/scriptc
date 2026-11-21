// Type assertions do not change the elements or identity of a JavaScript
// array. Exercise dynamic -> typed -> dynamic views with 32 source shapes.
for (let row = 0; row < 32; row++) {
  const original: any[] = ['x', undefined, 'z'];
  if ((row & 1) !== 0) original[1] = null;
  if ((row & 2) !== 0) original[1] = 42;
  if ((row & 4) !== 0) original[1] = false;
  if ((row & 8) !== 0) delete original[0];
  if ((row & 16) !== 0) original.length = 5;
  const view = original as string[];
  const erased = view as any[];
  console.log(row, JSON.stringify(view), typeof erased[1], erased === original);
  view[2] = 'typed';
  console.log('typed', JSON.stringify(original));
  erased[2] = 'dynamic';
  console.log('dynamic', JSON.stringify(original), view[2]);
}

const nestedOwner: any[] = [undefined, 'a', 3];
const strings = nestedOwner as string[];
const numbers = strings as unknown as number[];
const nestedErased = numbers as any[];
console.log('nested', JSON.stringify(numbers), typeof nestedErased[0], nestedErased === nestedOwner);
nestedErased[2] = 'new';
console.log('nested mutation', JSON.stringify(nestedOwner));
