function keep<TResult>(value: TResult): TResult;
function keep<P extends object, TResult>(value: TResult, context: P): TResult;
function keep<P extends object, TResult>(value: TResult, context?: P): TResult {
  if (context !== undefined) console.log("context");
  return value;
}

console.log(keep(42));
