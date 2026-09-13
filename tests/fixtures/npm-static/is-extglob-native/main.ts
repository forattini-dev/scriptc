import isExtglob from "is-extglob";
for (const value of ["+(one|two)", "plain", "\\@(foo)", "\\a+(b)", "\\a\\b", "\\a\\b?(c)", "", "!(a)", "@(a)", "*(a)", "?(a)", "(a)", "abc+(a)def", "\\+(one|two)", "\\\\+(a)", "😀+(a)", "a\nb+(c)"]) {
  console.log(JSON.stringify(value), isExtglob(value));
}
