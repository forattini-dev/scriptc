class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }

  override toString(): string {
    return `custom[${super.toString()}]`;
  }
}

class InheritedError extends AppError {}

class DetailedError extends AppError {
  override toString(): string {
    return `detail[${super.toString()}]`;
  }
}

function render(error: Error): void {
  console.log(error.toString());
  console.log(String(error));
  console.log(`${error}`);
}

render(new Error("plain"));
render(new AppError("broken"));
render(new InheritedError("inherited"));
render(new DetailedError("detail"));

const empty = new Error("");
empty.name = "";
render(empty);
