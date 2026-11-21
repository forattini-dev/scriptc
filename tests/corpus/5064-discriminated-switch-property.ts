type Token =
  | { type: "directive"; source: string }
  | { type: "space"; width: number };

function describe(token: Token): string {
  switch (token.type) {
    case "directive":
      return token.source.toUpperCase();
    case "space":
      return String(token.width);
  }
}

console.log(describe({ type: "directive", source: "yaml" }));
console.log(describe({ type: "space", width: 2 }));
