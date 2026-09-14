try {
  throw "boom";
} catch ({ message }: any) {
  console.log("destructuring catch bindings are fenced");
}
function f(): number {
  try {
    console.log("body");
  } finally {
    // A return inside finally replaces the pending completion.
    return 1;
  }
}
for (let i = 0; i < f(); i = i + 1) {
  try {
    if (i === 2) {
      break;
    }
  } finally {
    console.log("per-iteration cleanup");
  }
  while (i > 0) {
    try {
      console.log(i);
    } finally {
      continue;
    }
  }
}
