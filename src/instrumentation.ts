/** Runs once per server boot: fail fast on misconfigured environments. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/server/env");
    getEnv();
  }
}
