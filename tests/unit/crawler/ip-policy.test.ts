import { describe, expect, it } from "vitest";
import { isPublicAddress } from "@/server/crawler/ip-policy";

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "1.1.1.1", "104.20.23.154", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])("allows public %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["10.1.2.3", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.255", "RFC1918"],
    ["192.168.1.1", "RFC1918"],
    ["169.254.169.254", "cloud metadata / link-local"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.0.170", "IETF"],
    ["192.0.2.10", "TEST-NET"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["240.0.0.1", "reserved"],
    ["::", "unspecified v6"],
    ["::1", "loopback v6"],
    ["fe80::1", "link-local v6"],
    ["fc00::1", "ULA"],
    ["fd12:3456::1", "ULA"],
    ["ff02::1", "multicast v6"],
    ["::ffff:127.0.0.1", "v4-mapped loopback"],
    ["::ffff:169.254.169.254", "v4-mapped metadata"],
    ["::ffff:10.0.0.1", "v4-mapped private"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of 169.254.169.254"],
    ["2001:db8::1", "documentation"],
    ["2002:7f00:1::", "6to4 of loopback"],
    ["fd00:ec2::254", "AWS IMDS v6 (ULA)"],
    ["not-an-ip", "garbage"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it("allows v4-mapped public addresses", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });
});
