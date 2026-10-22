import { describe, expect, it } from "vitest";
import { normalizeAnswerText } from "@/server/providers/normalize";

describe("normalizeAnswerText", () => {
  it("strips markdown while keeping content and list structure", () => {
    const raw = "## Top picks\n\n1. **HubSpot** – great for *startups* ([hubspot.com](https://hubspot.com/?utm=x))\n* __Pipedrive__: `pipeline` focus\n\n\n\n> Note: prices vary";
    expect(normalizeAnswerText(raw)).toBe("Top picks\n\n1. HubSpot – great for startups (hubspot.com)\n- Pipedrive: pipeline focus\n\nNote: prices vary");
  });

  it("keeps intra-word underscores and asterisks used as math", () => {
    expect(normalizeAnswerText("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });

  it("flattens tables and normalizes unicode and whitespace", () => {
    const raw = "| Tool | Price |\n|---|---|\n| Close | $49 |\r\nCafé  x";
    expect(normalizeAnswerText(raw)).toBe("Tool | Price\n\nClose | $49\nCafé x");
  });
});
