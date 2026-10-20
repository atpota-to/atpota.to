// Vercel Function (Node.js runtime, Web handlers): the garden page: one person's flowers
// (their flower in the open patch and the ones they grew before; see server/gardener.ts).
//   GET / HEAD ?did=<did>  -> { did, handle, flowers: [...] }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createGardenerHandlers } from '../server/gardener.js';

const gardener = createGardenerHandlers();

export function GET(request: Request): Promise<Response> {
  return gardener.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return gardener.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return gardener.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return gardener.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return gardener.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return gardener.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return gardener.methodNotAllowed(request);
}
