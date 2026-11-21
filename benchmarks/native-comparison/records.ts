interface Sample {
  key: string;
  value: number;
  enabled: boolean;
}

function recordsWorkload(size: number, rounds: number): string {
  const samples: Sample[] = [];
  for (let index = 0; index < size; index += 1) {
    samples.push({
      key: `key-${index % 97}`,
      value: (index * 31) % 1009,
      enabled: index % 3 !== 0,
    });
  }

  let checksum = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample.enabled) {
        checksum = (checksum + sample.value + sample.key.length + round) % 2147483647;
      }
    }
  }

  return `${samples.length}:${checksum}`;
}

console.log(`records:${recordsWorkload(25000, 6)}`);
