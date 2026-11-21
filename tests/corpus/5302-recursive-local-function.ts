function walk(value: number): number {
  function processNode(node: number): number {
    if (node <= 0) return 0;
    return [node - 1].map(child => processNode(child))[0] + 1;
  }

  return processNode(value);
}

console.log(walk(4));
