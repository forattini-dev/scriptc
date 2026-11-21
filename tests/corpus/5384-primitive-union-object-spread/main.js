function spread(kind) {
  const source = kind === 0
    ? { name: 'native' }
    : kind === 1
      ? 'ok'
      : undefined;
  return { ...source, tail: true };
}

console.log(JSON.stringify(spread(0)));
console.log(JSON.stringify(spread(1)));
console.log(JSON.stringify(spread(2)));
