import { randomUUID } from "node:crypto";
import winston from "winston"

export const logger = winston.createLogger({ //creates one shared logger for the whole app
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({stack:true}),
    winston.format.json(),
  ),
  defaultMeta: {service:"booking-app"},
  transports:[new winston.transports.Console()], //This determines where the logs will go.
})

export function createRouteLogger(endpoint:string, method:string){
  const startedAt = Date.now();
  const log = logger.child({endpoint, method, requestId:randomUUID()});
  return Object.assign(log,{duration: ()=> Date.now() - startedAt});
}

export type RouteLogger = ReturnType<typeof createRouteLogger>;