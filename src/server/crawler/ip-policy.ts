/**
 * Network-level SSRF policy: an address may be contacted only if it is
 * globally routable unicast. Everything else (loopback, RFC 1918, link-local
 * incl. cloud metadata 169.254.169.254, CGNAT, ULA, multicast, reserved,
 * documentation ranges, IPv4-mapped/translated forms of those) is blocked.
 */
import ipaddr from "ipaddr.js";

export type IpPolicy = (address: string) => boolean;

// Ranges ipaddr.js reports as "unicast" but which must never be contacted.
const EXTRA_BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["100.64.0.0", 10], // CGNAT (some ipaddr versions report "carrierGradeNat")
  ["240.0.0.0", 4], // reserved
];

const EXTRA_BLOCKED_V6: Array<[string, number]> = [
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2001::", 23], // IETF protocol assignments (Teredo etc.)
  ["2002::", 16], // 6to4 (can embed private v4)
  ["fec0::", 10], // deprecated site-local
];

function v4Blocked(addr: ipaddr.IPv4): boolean {
  if (addr.range() !== "unicast") return true;
  return EXTRA_BLOCKED_V4.some(([net, bits]) => addr.match(ipaddr.IPv4.parse(net), bits));
}

export const isPublicAddress: IpPolicy = (address) => {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv4") return !v4Blocked(parsed as ipaddr.IPv4);

  const v6 = parsed as ipaddr.IPv6;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 well-known prefix (64:ff9b::/96) embed a v4 address.
  if (v6.isIPv4MappedAddress()) return !v4Blocked(v6.toIPv4Address());
  if (v6.match(ipaddr.IPv6.parse("64:ff9b::"), 96)) {
    const bytes = v6.toByteArray().slice(12);
    return !v4Blocked(new ipaddr.IPv4(bytes));
  }
  if (v6.range() !== "unicast") return false;
  if (EXTRA_BLOCKED_V6.some(([net, bits]) => v6.match(ipaddr.IPv6.parse(net), bits))) return false;
  // Only the global unicast block 2000::/3 is publicly routable.
  return v6.match(ipaddr.IPv6.parse("2000::"), 3);
};
