// Vercel Function (Node.js runtime, Web handlers): the garden page: one person, their own
// garden, the flowers they've planted in anyone's garden and the tending they've given
// (see server/gardener.ts).
//   GET / HEAD ?actor=<did or handle>  -> { did, handle, displayName, avatar, garden, flowers, given }
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
