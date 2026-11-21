const top = require("node:path")

function nested(value) {
  const local = require("node:path")
  return local.basename(value)
}

console.log(top.dirname("a/b/c.txt"), nested("x/y.txt"), require("node:path").extname("z.json"))
