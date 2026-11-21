class Marker {
  text(value: number): string {
    return `marker:${value}`;
  }
}

async function readResponse(): Promise<string> {
  return fetch("https://example.invalid")
    .then((response) => (response.ok ? response.text() : ""))
    .catch(() => "");
}

void readResponse;
console.log(new Marker().text(2));
