const values = new Set(["alpha", "beta", "alpha", "gamma"])

console.log(Array.from(values.values()).join("|"))
console.log(Array.from(values.keys()).join("|"))
console.log(Array.from(values.values(), (value, index) => `${index}:${value}`).join(","))

const visited: string[] = []
for (const value of values.values()) {
  visited.push(value.toUpperCase())
}
console.log(visited.join("|"))
