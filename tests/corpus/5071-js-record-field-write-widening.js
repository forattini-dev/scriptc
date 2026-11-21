// @ts-nocheck
function load() {
  return { message: "changed" };
}

function message(data) {
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null && "message" in data) {
    const objectData = data;
    return `${objectData.message}`;
  }
  return "unknown";
}

function main() {
  const response = { data: "" };
  response.data = load();
  console.log(message(response.data));
}

main();
