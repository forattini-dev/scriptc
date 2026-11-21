// Untyped producers: the checker sees `any`, like a JavaScript dependency.
export function* matchedRoutes(paths) {
  try {
    for (const path of paths) {
      console.log("yield", path);
      yield { path, guard: path.includes("admin") ? async () => false : undefined };
    }
  } finally {
    console.log("generator closed");
  }
}

export function matchedArray(paths) {
  return paths.map((path) => ({ path, guard: path.includes("admin") ? async () => false : undefined }));
}
