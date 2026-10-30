export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startKeepWarm, keepWarmInterval } = await import("./lib/keep-warm");
    const { wakeServices } = await import("./lib/services");
    // First, before migrations: rating and ingestion start booting while this machine finishes
    // starting, so a user who just signed in doesn't wait for them on their first Extract or rate.
    startKeepWarm(wakeServices, keepWarmInterval(process.env));
    const { migrate } = await import("./lib/migrate");
    await migrate();
  }
}
