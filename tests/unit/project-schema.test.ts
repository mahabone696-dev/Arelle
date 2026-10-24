import { describe, expect, it } from "vitest";
import { createProjectSchema } from "@/server/projects/schemas";
import { slugify } from "@/lib/utils";
import { toLocale } from "@/lib/i18n";

describe("createProjectSchema", () => {
  it("normalizes domain, country and language", () => {
    const r = createProjectSchema.parse({ name: " Acme ", domain: "https://www.acme.com/x", country: "gb", language: "EN", timezone: "Europe/London" });
    expect(r).toEqual({ name: "Acme", domain: "acme.com", country: "GB", language: "en", timezone: "Europe/London" });
  });

  it("rejects unsafe domains, unknown markets and bad timezones", () => {
    const r = createProjectSchema.safeParse({ name: "A", domain: "http://127.0.0.1", country: "XX", language: "zz", timezone: "Mars/Base" });
    expect(r.success).toBe(false);
    const fields = r.success ? {} : r.error.flatten().fieldErrors;
    expect(Object.keys(fields).sort()).toEqual(["country", "domain", "language", "name", "timezone"]);
  });
});

describe("helpers", () => {
  it("slugify", () => {
    expect(slugify("Acme Café & Co.")).toBe("acme-cafe-co");
    expect(slugify("---")).toBe("");
  });
  it("toLocale", () => {
    expect(toLocale("EN", "gb")).toBe("en-GB");
  });
});
