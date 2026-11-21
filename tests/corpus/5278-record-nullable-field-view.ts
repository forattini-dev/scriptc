interface Link {
  key: string;
  url: string | null;
}

const concrete = { key: "docs", url: "https://example.test" };
const link: Link = concrete;
console.log(link.url);
