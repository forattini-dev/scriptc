// @ts-nocheck

function cacheKey({ repositoryNames = [] }) {
  return repositoryNames.join(",");
}

console.log(cacheKey({ repositoryNames: ["two", "one"] }));
