// Vercel Function (Node.js runtime, Web handlers): someone's garden page, with its title,
// description and Open Graph tags made theirs (server/garden-page.ts). vercel.json rewrites
// /garden/<actor> and /garden/<actor>/flowers here.
//   GET / HEAD ?actor=<handle or DID>[&level=flowers]  -> text/html
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createGardenPageHandlers } from '../server/garden-page.js';

const garden = createGardenPageHandlers();

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
