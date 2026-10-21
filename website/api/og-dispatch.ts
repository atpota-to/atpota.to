// Vercel Function (Node.js runtime, Web handlers): one dispatch issue's Open Graph card
// (server/og-dispatch.ts). vercel.json rewrites /og/dispatch/<key>.png here.
//   GET / HEAD ?key=<record key or path>  -> image/png, 1200x630, or a redirect to /og/blog.png
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createOgDispatchHandlers } from '../server/og-dispatch.js';

const og = createOgDispatchHandlers();

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
