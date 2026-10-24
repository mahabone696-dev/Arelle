import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "@/server/crawler/safe-fetch";
import { assertCrawlableUrl } from "@/server/crawler/url-policy";
import { CrawlError } from "@/server/crawler/errors";

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    switch (url.pathname) {
      case "/ok":
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<title>ok</title><p>ua=${req.headers["user-agent"]}</p>`);
        return;
      case "/redirect-ok":
        res.writeHead(302, { location: "/ok" }).end();
        return;
      case "/redirect-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        return;
      case "/redirect-private":
        res.writeHead(301, { location: `http://127.0.0.2:${port}/ok` }).end();
        return;
      case "/redirect-file":
        res.writeHead(302, { location: "file:///etc/passwd" }).end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" }).end();
        return;
      case "/huge":
        res.setHeader("content-type", "text/html");
        res.write("x".repeat(60_000));
        res.end("x".repeat(60_000));
        return;
      case "/huge-declared":
        res.writeHead(200, { "content-type": "text/html", "content-length": "999999999" });
        res.end("tiny");
        return;
      case "/slow":
        res.setHeader("content-type", "text/html");
        res.write("<p>start");
        setTimeout(() => res.end("</p>"), 3_000);
        return;
      case "/gzip":
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end("not really gzip");
        return;
      case "/binary":
        res.writeHead(200, { "content-type": "application/octet-stream" }).end("bin");
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// Lets the local test server through while every other URL gets the real policy.
const urlPolicyForTests = (u: string | URL) => {
  const url = new URL(u);
  return (url.hostname === "localhost" || url.hostname === "127.0.0.2") && url.port === String(port) ? url : assertCrawlableUrl(url);
};
const onlyLoopback1 = (ip: string) => ip === "127.0.0.1" || ip === "::1";
const opts = { maxBytes: 100_000, timeoutMs: 1_500, urlPolicyForTests, ipPolicy: onlyLoopback1, contentTypes: ["text/html"] };

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof CrawlError ? e.code : `UNEXPECTED:${String(e)}`;
  }
}

describe("safeFetch", () => {
  it("fetches an allowed page with our user agent", async () => {
    const res = await safeFetch(`${base}/ok`, opts);
    expect(res.status).toBe(200);
    expect(res.body).toContain("ArelleBot");
  });

  it("blocks loopback at connect time under the default IP policy (DNS-level guard)", async () => {
    expect(await code(safeFetch(`${base}/ok`, { ...opts, ipPolicy: undefined }))).toBe("BLOCKED_ADDRESS");
  });

  it("re-validates every redirect hop", async () => {
    const ok = await safeFetch(`${base}/redirect-ok`, opts);
    expect(ok.finalUrl).toBe(`${base}/ok`);
    expect(ok.redirects).toEqual([`${base}/ok`]);
    expect(await code(safeFetch(`${base}/redirect-metadata`, opts))).toBe("BLOCKED_ADDRESS");
    expect(await code(safeFetch(`${base}/redirect-file`, opts))).toBe("INVALID_URL");
    // Passes the URL policy but resolves to an address outside the IP policy.
    expect(await code(safeFetch(`${base}/redirect-private`, opts))).toBe("BLOCKED_ADDRESS");
  });

  it("limits redirects", async () => {
    expect(await code(safeFetch(`${base}/loop`, { ...opts, maxRedirects: 3 }))).toBe("TOO_MANY_REDIRECTS");
  });

  it("enforces body size limits (streamed and declared)", async () => {
    expect(await code(safeFetch(`${base}/huge`, opts))).toBe("TOO_LARGE");
    expect(await code(safeFetch(`${base}/huge-declared`, opts))).toBe("TOO_LARGE");
  });

  it("times out slow responses, including slow bodies", async () => {
    expect(await code(safeFetch(`${base}/slow`, { ...opts, timeoutMs: 500 }))).toBe("TIMEOUT");
  });

  it("refuses compressed and non-HTML responses", async () => {
    expect(await code(safeFetch(`${base}/gzip`, opts))).toBe("UNSUPPORTED_CONTENT");
    expect(await code(safeFetch(`${base}/binary`, opts))).toBe("UNSUPPORTED_CONTENT");
  });

  it("applies the real URL policy to the initial URL by default", async () => {
    expect(await code(safeFetch("http://127.0.0.1/", { maxBytes: 1000, timeoutMs: 1000 }))).toBe("BLOCKED_ADDRESS");
    expect(await code(safeFetch("http://localhost/", { maxBytes: 1000, timeoutMs: 1000 }))).toBe("BLOCKED_ADDRESS");
  });
});
