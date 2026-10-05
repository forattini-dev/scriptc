class DisplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayError";
  }

  override toString(): string {
    return `custom:${this.name}|${this.message}`;
  }
}

console.log(new DisplayError("broken").toString());
