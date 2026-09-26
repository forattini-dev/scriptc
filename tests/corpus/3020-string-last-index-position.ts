const repeated = "ababa";
for (const position of [-Infinity, -3, -0.5, 0, 0.9, 1, 2.9, 3, 4, 5, Infinity, NaN]) {
  console.log(
    repeated.lastIndexOf("a", position),
    repeated.lastIndexOf("ba", position),
    repeated.lastIndexOf("", position),
    repeated.lastIndexOf("x", position),
  );
}

const unicode = "😀x😀y";
for (const position of [-1, 0, 1, 2, 3, 4, 5, 6, Infinity, NaN]) {
  console.log(
    unicode.lastIndexOf("😀", position),
    unicode.lastIndexOf("x", position),
    unicode.lastIndexOf("", position),
  );
}

function optionalPosition(usePosition: boolean): number | undefined {
  return usePosition ? 2 : undefined;
}
console.log(repeated.lastIndexOf("a"), repeated.lastIndexOf("a", undefined));
console.log(repeated.lastIndexOf("a", optionalPosition(true)), repeated.lastIndexOf("a", optionalPosition(false)));
