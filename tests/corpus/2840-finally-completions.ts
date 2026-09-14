const trail: string[] = [];

for (let i = 0; i < 5; i = i + 1) {
  try {
    trail.push("try " + i);
    if (i === 1) continue;
    if (i === 3) break;
    trail.push("body " + i);
  } finally {
    trail.push("finally " + i);
  }
}

outer: for (let i = 0; i < 2; i = i + 1) {
  for (let j = 0; j < 2; j = j + 1) {
    try {
      trail.push("nested " + i + ":" + j);
      break outer;
    } finally {
      trail.push("nested finally " + i + ":" + j);
    }
  }
}

function returnFromFinally(): string {
  try {
    return "try return";
  } finally {
    return "finally return";
  }
}

function returnReplacesThrow(): string {
  try {
    throw new Error("discarded");
  } finally {
    return "throw replaced";
  }
}

function breakReplacesReturn(): string {
  let answer = "before";
  outer: for (let i = 0; i < 1; i = i + 1) {
    try {
      return "discarded return";
    } finally {
      answer = "break replaced return";
      break outer;
    }
  }
  return answer;
}

function continueReplacesBreak(): string {
  const out: string[] = [];
  for (let i = 0; i < 2; i = i + 1) {
    try {
      out.push("try " + i);
      break;
    } finally {
      if (i === 0) {
        out.push("continue");
        continue;
      }
      out.push("break");
    }
  }
  return out.join(",");
}

console.log(trail.join(" | "));
console.log(returnFromFinally());
console.log(returnReplacesThrow());
console.log(breakReplacesReturn());
console.log(continueReplacesBreak());
