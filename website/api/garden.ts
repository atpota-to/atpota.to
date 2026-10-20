// Vercel Function (Node.js runtime, Web handlers): the home page's flower patch
// (the seasonal patches and the flowers visitors planted in their own repos; see server/garden.ts).
//   GET / HEAD [?patch=<rkey>]  -> { patch, patches, flowers, total }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createGardenHandlers } from '../server/garden.js';

const garden = createGardenHandlers();

export function GET(request: Request): Promise<Response> {
  return garden.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return garden.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return garden.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return garden.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return garden.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return garden.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return garden.methodNotAllowed(request);
}
