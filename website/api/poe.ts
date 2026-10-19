// Vercel Function (Node.js runtime, Web handlers): the Poe chat proxy (SPEC 4.1-4.4).
//   POST   /api/poe  {"message","path","selection"?}  -> text/event-stream
//   DELETE /api/poe  -> 204, clears the conversation cookie
//   anything else    -> 405
// The logic lives in ../server (outside api/, so Vercel builds only this entry point).
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createPoeHandlers } from '../server/handler.js';

const poe = createPoeHandlers();

export function POST(request: Request): Promise<Response> {
  return poe.POST(request);
}

export function DELETE(request: Request): Promise<Response> {
  return poe.DELETE(request);
}

export function GET(request: Request): Promise<Response> {
  return poe.methodNotAllowed(request);
}

export function HEAD(request: Request): Promise<Response> {
  return poe.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return poe.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return poe.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return poe.methodNotAllowed(request);
}
