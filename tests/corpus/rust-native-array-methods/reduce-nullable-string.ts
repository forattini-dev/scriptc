const rows = [
  { created_at: "2026-01-02" },
  { created_at: "2026-01-01" },
];

const oldest = rows.reduce<string | null>((current, row) => {
  if (current == null) return row.created_at;
  return row.created_at < current ? row.created_at : current;
}, null);

console.log(oldest);
