/**
 * @param {string} shell
 * @returns {string}
 */
function completion(shell) {
  switch (shell) {
    case "bash":
      return "B";
    case "zsh":
      return "Z";
    case "fish":
      return "F";
  }
}

console.log(String(completion("bash")));
console.log(String(completion("unknown")));
