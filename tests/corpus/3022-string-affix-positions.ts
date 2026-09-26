const text = "a😀bc😀d";
for (const position of [NaN, -Infinity, -2, -0, 0, 1, 1.9, 2, 3, 4, 5, 6, 7, 8, Infinity]) {
  console.log(
    text.startsWith("a", position),
    text.startsWith("😀", position),
    text.startsWith("bc", position),
    text.startsWith("", position),
  );
  console.log(
    text.endsWith("a", position),
    text.endsWith("😀", position),
    text.endsWith("bc", position),
    text.endsWith("", position),
  );
}

console.log("😀".startsWith("�", 1), "😀".endsWith("�", 1));
console.log("a😀b".startsWith("b", 3), "a😀b".endsWith("😀", 3));
