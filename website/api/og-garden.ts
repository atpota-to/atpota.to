// Vercel Function (Node.js runtime, Web handlers): a garden's Open Graph card, drawn from
// the garden as it is now (server/og-garden.ts). vercel.json rewrites /og/garden/<actor>.png here.
//   GET / HEAD ?actor=<handle or DID>  -> image/png, 1200x630, or a redirect to /og/garden.png
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createOgGardenHandlers } from '../server/og-garden.js';

const og = createOgGardenHandlers();

export function GET(request: Request): Promise<Response> {
  return og.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return og.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return og.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return og.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return og.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return og.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return og.methodNotAllowed(request);
}
