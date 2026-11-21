import { Item } from "./item.ts"
import { TimeoutError } from "./errors.ts"
import type { ItemView } from "./types.ts"

const makeEarly = () => new TimeoutError(item)
const item = new Item()
new TimeoutError(undefined)
const recordItem: ItemView = { value: 10 }
new TimeoutError(recordItem)
const error = new TimeoutError(item)
makeEarly()
error.item!.value++
console.log(error.message, item.value, error.item === item)
