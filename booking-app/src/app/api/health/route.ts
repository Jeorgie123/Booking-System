import { connection } from "next/server";
import { fail, ok } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { createRouteLogger } from "@/utils/logger";
import { handleRouteError } from "@/utils/handleRouteError";

export async function GET() {
  await connection();
  const log = createRouteLogger("health", "GET");
  try {
    log.info("HEALTH_OK", { durationMs: log.duration() });
    return ok({ status: "ok" });
  } catch (err) {
    if (err instanceof AppError) return fail(err.message, err.status);
    handleRouteError(err, log);
    return fail("Something went wrong", 500);
  }
}