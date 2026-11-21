// @rust-only
// @no-engine
// @ts-nocheck
import dns from "node:dns/promises";

async function main(): Promise<void> {
  // The live branch is opt-in so the parity suite does not depend on external
  // DNS. It still forces both typed record payloads through native lowering.
  const live = false as boolean;
  if (live) {
    const a = await dns.resolve4("example.com");
    const aWithTtl = await dns.resolve4("example.com", { ttl: true });
    const aaaa = await dns.resolve6("example.com");
    const aaaaWithTtl = await dns.resolve6("example.com", { ttl: true });
    const caa = await dns.resolveCaa("example.com");
    const cname = await dns.resolveCname("example.com");
    const mx = await dns.resolveMx("example.com");
    const naptr = await dns.resolveNaptr("example.com");
    const ns = await dns.resolveNs("example.com");
    const ptr = await dns.resolvePtr("1.0.0.127.in-addr.arpa");
    const reverse = await dns.reverse("127.0.0.1");
    const soa = await dns.resolveSoa("example.com");
    const srv = await dns.resolveSrv("_http._tcp.example.com");
    const txt = await dns.resolveTxt("example.com");
    console.log(
      a[0],
      aWithTtl[0]?.ttl,
      aaaa[0],
      aaaaWithTtl[0]?.address,
      caa[0]?.critical,
      cname[0],
      mx[0]?.priority,
      mx[0]?.exchange,
      naptr[0]?.service,
      ns[0],
      ptr[0],
      reverse[0],
      soa.nsname,
      srv[0]?.port,
      txt.flat()[0],
    );
  }
  console.log("dns records ready");
}

main();
