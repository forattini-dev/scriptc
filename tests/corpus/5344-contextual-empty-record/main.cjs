// @rust-only
// @no-engine
/** @type {Record<'Accept'|'accept', string>} */
const names = {}
Object.setPrototypeOf(names, null)

for (const name of ['Accept']) {
  names[name] = name.toLowerCase()
  names[name.toLowerCase()] = name
}

console.log(names.Accept, names.accept)
