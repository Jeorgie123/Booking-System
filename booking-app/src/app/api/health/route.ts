import { connection } from "next/server"; // It tells Next.js that this part of the code needs to wait for an actual incoming request before continuing.
import { ok } from "@/lib/http";

export async function GET() {
  await connection();
  return ok({ status: "ok" });
}