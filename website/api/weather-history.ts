// Vercel Function (Node.js runtime, Web handlers): the weather report's trends
// (the weather station's minute rows in Supabase; see server/weather-history.ts).
//   GET / HEAD ?range=hour|day|week|month|year  -> { range, points, total, apps?, compare?, appsOverTime?, accounts?, hosts? }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createHistoryHandlers } from '../server/weather-history.js';

const history = createHistoryHandlers();

export function GET(request: Request): Promise<Response> {
  return history.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return history.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return history.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return history.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return history.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return history.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return history.methodNotAllowed(request);
}
