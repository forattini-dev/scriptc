console.log("basic", unescape("%41%u0042%u00e9"), unescape("%E2%98%83"));
console.log("malformed", unescape("%uZZZZ%2G%U0041%%41"));
