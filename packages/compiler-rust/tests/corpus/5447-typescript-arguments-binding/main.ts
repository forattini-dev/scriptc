class ElementLike {
  setAttribute(key: string, value: string) {
    if (arguments.length < 2) {
      throw new Error(`expected 2 arguments, got ${arguments.length}`)
    }
    return `${key}:${value}:${arguments.length}`
  }
}

const element = new ElementLike()
console.log(element.setAttribute("id", "main"))
// @ts-expect-error JavaScript still supplies the extra argument to the method.
console.log(element.setAttribute("role", "button", "ignored"))
try {
  // @ts-expect-error JavaScript still enters the method with one argument.
  element.setAttribute("title")
} catch (error) {
  console.log((error as Error).message)
}
