class Fault extends Error { context: unknown; constructor(value: unknown) { super(); this.context = value; } }
const fault = new Fault(1);
const erasedError: unknown = fault;
console.log("error-fields", (erasedError as any).context === 1, (erasedError as any).message === "");
