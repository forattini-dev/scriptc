console.log("self", process.kill(process.pid, 0));
if (process.platform === "win32") {
  try {
    process.kill(4, 0);
    console.log("protected", "allowed");
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("protected", caught.code === "EPERM", caught.message);
  }
}
try {
  process.kill(2147483647, 0);
} catch (error) {
  const caught = error as NodeJS.ErrnoException;
  console.log("missing", caught.name, caught.code === "ESRCH", caught.message);
}
try {
  process.kill(1.5, 0);
} catch (error) {
  const caught = error as NodeJS.ErrnoException;
  console.log("invalid", caught.name, caught.code === "ERR_INVALID_ARG_TYPE", caught.message);
}
