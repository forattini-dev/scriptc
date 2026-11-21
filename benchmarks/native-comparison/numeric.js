/**
 * @param {number} rounds
 * @param {number} width
 */
function numericWorkload(rounds, width) {
  let checksum = 1;
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 1; index <= width; index += 1) {
      checksum = (checksum * 48271 + index + round) % 2147483647;
    }
  }
  return checksum;
}

console.log(`numeric:${numericWorkload(15, 200000)}`);
