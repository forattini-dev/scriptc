import type { ItemView } from "./types.ts"

export class BaseError extends Error {
  item?: ItemView
  constructor(message: string, item?: ItemView) {
    super(message)
    this.item = item
  }
}

export class TimeoutError extends BaseError {
  constructor(item?: ItemView) {
    super("timeout", item)
  }
}
