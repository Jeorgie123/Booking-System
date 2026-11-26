import type { RouteLogger } from "@/utils/logger";

export function handleRouteError(err: unknown, log: RouteLogger) {
  log.error("EXCEPTION", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    durationMs: log.duration(),
  });
}