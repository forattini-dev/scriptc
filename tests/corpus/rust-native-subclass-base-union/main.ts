class ReckerError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "ReckerError";
  }
}
class QueueCancelledError extends ReckerError {
  constructor(message: string) {
    super(message, "QUEUE_CANCELLED");
    this.name = "QueueCancelledError";
  }
}

class Runner {
  private cancelReason: QueueCancelledError | Error = new QueueCancelledError("Request runner cancelled");

  cancel(reason?: Error): void {
    if (reason) this.cancelReason = reason;
  }

  describe(): string {
    const reason = this.cancelReason;
    const code = reason instanceof QueueCancelledError ? reason.code : "none";
    return `${reason.name}: ${reason.message} [${code}]`;
  }
}

const runner = new Runner();
console.log(runner.describe());
runner.cancel(new Error("manual stop"));
console.log(runner.describe());
runner.cancel(new QueueCancelledError("drained"));
console.log(runner.describe());

class Shape {
  area(): number { return 0; }
  label(): string { return `shape ${this.area()}`; }
}
class Square extends Shape {
  private readonly side: number;
  constructor(side: number) { super(); this.side = side; }
  area(): number { return this.side * this.side; }
}
let current: Square | Shape = new Square(3);
console.log(current.label(), current instanceof Square);
current = new Shape();
console.log(current.label(), current instanceof Square);
