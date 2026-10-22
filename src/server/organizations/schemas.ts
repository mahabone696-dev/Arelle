import { z } from "zod";

export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "audit", "auth", "billing", "dashboard", "docs", "help", "login",
  "logout", "new", "onboarding", "orgs", "pricing", "r", "report", "reports", "settings",
  "sign-in", "sign-up", "signin", "signup", "static", "support", "_next", "www",
]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80, "Name is too long"),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
