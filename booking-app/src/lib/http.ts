import { NextResponse } from "next/server";

export const ok = <T extends object>(data: T, status = 200) => 
  NextResponse.json({success: true, ...data}, {status});

export const fail = (message: string, status: number, details?: unknown) => 
  NextResponse.json({success: false, message, details}, {status})