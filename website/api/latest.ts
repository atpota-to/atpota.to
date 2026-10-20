// Vercel Function (Node.js runtime, Web handlers): the home page's unified "latest" feed
// (posts from atpota.to, poe, anisota and aturi, plus the dispatch; see server/latest.ts).
//   GET / HEAD  -> { items: [...] }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createLatestHandlers } from '../server/latest.js';

const latest = createLatestHandlers();

export function GET(request: Request): Promise<Response> {
  return latest.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return latest.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return latest.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return latest.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return latest.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return latest.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return latest.methodNotAllowed(request);
}
