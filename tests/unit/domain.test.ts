import { describe, expect, it } from "vitest";
import { normalizeDomain } from "@/lib/domain";

const ok = (input: string) => {
  const r = normalizeDomain(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.reason}`);
  return r.domain;
};

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["https://www.Example.com/pricing?x=1", "example.com"],
    ["http://shop.example.co.uk", "shop.example.co.uk"],
    ["  EXAMPLE.io  ", "example.io"],
    ["https://example.com:443/", "example.com"],
    ["xn--bcher-kva.example.de", "xn--bcher-kva.example.de"],
    ["https://bücher.de", "xn--bcher-kva.de"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(ok(input)).toBe(expected);
  });

  it.each([
    "",
    "localhost",
    "http://localhost:3000",
    "127.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://2130706433",
    "ftp://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:pass@example.com",
    "http://example.com:8080",
    "intranet",
    "printer.local",
    "metadata.google.internal",
    "-bad-.com",
    "example.c0m",
  ])("rejects %s", (input) => {
    expect(normalizeDomain(input).ok).toBe(false);
  });
});
