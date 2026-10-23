/**
 * Seed script.
 *  1. Platform configuration: AI providers/models and feature flag rows (safe in every env).
 *  2. DEMO organization with clearly-labelled demo data (non-production only).
 *
 * Demo data lives in an organization with isDemo = true and must never be
 * mixed with real scan data. Demo scan responses/snapshots are added in Phase 5.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/auth/password";
import { FEATURE_FLAGS } from "../src/server/flags/definitions";
import { seedDemoScans } from "./demo-data";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

// List prices in USD per 1M tokens; `request` is the per-call web search fee.
// VERIFY against current provider pricing before launch — cost caps depend on these.
const PROVIDERS = [
  { slug: "openai", displayName: "ChatGPT", enabled: true, models: [{ modelId: "gpt-4.1-mini", displayName: "GPT-4.1 mini", input: 0.4, output: 1.6, request: 0.025, isDefault: true }] },
  { slug: "gemini", displayName: "Gemini", enabled: false, models: [] },
  { slug: "perplexity", displayName: "Perplexity", enabled: false, models: [{ modelId: "sonar", displayName: "Sonar", input: 1, output: 1, request: 0.005, isDefault: true }] },
] as const;

async function seedPlatform() {
  for (const p of PROVIDERS) {
    const provider = await db.aIProvider.upsert({
      where: { slug: p.slug },
      // isEnabled is only set on creation; later changes are an admin decision (pnpm admin provider ...).
      create: { slug: p.slug, displayName: p.displayName, isEnabled: p.enabled },
      update: { displayName: p.displayName },
    });
    for (const m of p.models) {
      await db.aIModel.upsert({
        where: { providerId_modelId: { providerId: provider.id, modelId: m.modelId } },
        create: {
          providerId: provider.id,
          modelId: m.modelId,
          displayName: m.displayName,
          inputCostPer1M: m.input,
          outputCostPer1M: m.output,
          requestCost: m.request,
          isDefault: m.isDefault,
        },
        update: { inputCostPer1M: m.input, outputCostPer1M: m.output, requestCost: m.request },
      });
    }
  }
  for (const [key, def] of Object.entries(FEATURE_FLAGS)) {
    await db.featureFlag.upsert({ where: { key }, create: { key, description: def.description }, update: { description: def.description } });
  }
  console.log("Seeded providers and feature flags");
}

async function seedDemo() {
  const email = "demo@arelle.dev";
  const password = process.env.SEED_DEMO_PASSWORD ?? "demo-password-123";
  const user = await db.user.upsert({
    where: { email },
    create: { email, name: "Demo User", passwordHash: await hashPassword(password) },
    update: {},
  });

  const org = await db.organization.upsert({
    where: { slug: "demo" },
    create: {
      name: "Demo Workspace",
      slug: "demo",
      isDemo: true,
      members: { create: { userId: user.id, role: "OWNER" } },
      subscription: { create: { planTier: "GROWTH", status: "ACTIVE" } },
    },
    update: {},
  });

  const project = await db.project.upsert({
    where: { organizationId_domain: { organizationId: org.id, domain: "demo-crm.example" } },
    create: {
      organizationId: org.id,
      name: "[DEMO] Northwind CRM",
      domain: "demo-crm.example",
      country: "US",
      language: "en",
      locale: "en-US",
      timezone: "America/New_York",
      onboardingStep: "COMPLETED",
      onboardingCompletedAt: new Date(),
    },
    update: {},
  });

  await db.brand.upsert({
    where: { projectId: project.id },
    create: {
      projectId: project.id,
      name: "Northwind CRM",
      domain: "demo-crm.example",
      description: "[DEMO DATA] A fictional CRM for small and mid-sized sales teams.",
      industry: "CRM software",
      products: ["Northwind CRM", "Northwind Pipelines"],
      targetCustomers: ["Startups", "SMB sales teams"],
      markets: ["US", "GB"],
      topics: ["CRM", "sales pipeline", "lead management"],
    },
    update: {},
  });

  for (const c of [
    { name: "HubSpot", domain: "hubspot.com" },
    { name: "Salesforce", domain: "salesforce.com" },
    { name: "Pipedrive", domain: "pipedrive.com" },
    { name: "Zoho CRM", domain: "zoho.com" },
    { name: "Close", domain: "close.com" },
  ]) {
    await db.competitor.upsert({
      where: { projectId_name: { projectId: project.id, name: c.name } },
      create: { projectId: project.id, ...c, source: "DEMO" },
      update: {},
    });
  }

  const prompts = [
    { text: "Best CRM software", intent: "COMMERCIAL", category: "CATEGORY", priority: 5 },
    { text: "Best CRM for startups", intent: "COMMERCIAL", category: "COMMERCIAL", priority: 5 },
    { text: "HubSpot alternatives", intent: "ALTERNATIVE", category: "ALTERNATIVE", priority: 4 },
    { text: "HubSpot vs Salesforce", intent: "COMPARISON", category: "COMPARISON", priority: 4 },
    { text: "Affordable CRM for small companies", intent: "TRANSACTIONAL", category: "PURCHASE_INTENT", priority: 4 },
    { text: "How to manage a remote sales team", intent: "INFORMATIONAL", category: "PROBLEM", priority: 2 },
    { text: "Is Northwind CRM good?", intent: "BRANDED", category: "BRANDED", priority: 3 },
  ] as const;
  for (const p of prompts) {
    await db.prompt.upsert({
      where: { projectId_text_country_language: { projectId: project.id, text: p.text, country: "US", language: "en" } },
      create: { projectId: project.id, ...p, country: "US", language: "en", source: "DEMO", reason: "[DEMO DATA]", approvedAt: new Date() },
      update: {},
    });
  }
  await seedDemoScans(db, project.id);
  console.log(`Seeded demo workspace: sign in as ${email}`);
}

async function main() {
  await seedPlatform();
  if (process.env.NODE_ENV === "production") {
    console.log("Skipping demo data in production");
    return;
  }
  await seedDemo();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
