let selections = 0;

function selectBase() {
  selections += 1;
  return DOMException;
}

class SelectedError extends selectBase() {}

const error = new SelectedError();
console.log(
  selections,
  error instanceof SelectedError,
  error instanceof DOMException,
);
