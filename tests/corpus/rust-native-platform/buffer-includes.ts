const bytes = Buffer.from([7, 0, 2]);
console.log(bytes.includes(0), bytes.includes(7, 1), bytes.includes(2, -1));
