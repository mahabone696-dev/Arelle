import { handleWebhook } from "@/server/billing/stripe";

// Stripe signs the exact raw body, so read it as text (never parse first).
export async function POST(request: Request) {
  const result = await handleWebhook(await request.text(), request.headers.get("stripe-signature"));
  return Response.json(result.body, { status: result.status });
}
