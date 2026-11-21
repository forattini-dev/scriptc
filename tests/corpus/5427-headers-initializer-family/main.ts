const record = new Headers({ "X-One": "record", "X-Two": "two" })
const pairs = new Headers([["X-Three", "pairs"], ["X-One", "pair"]])
const copy = new Headers(record)

copy.set("X-One", "copy")
const seen: string[] = []
copy.forEach((value, key, owner) => {
  seen.push(`${key}=${value}:${owner === copy}`)
})

console.log(record.get("x-one"))
console.log(pairs.get("x-three"), pairs.get("x-one"))
console.log(copy.get("x-one"), copy === record)
console.log(seen.join(","))
