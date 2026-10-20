// Vercel Function (Node.js runtime, Web handlers): the home page's "atmospheric conditions"
// (a few seconds of the firehose, counted; see server/atmosphere.ts).
//   GET / HEAD  -> { measuredAt, seconds, perSecond, condition }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createAtmosphereHandlers } from '../server/atmosphere.js';

const atmosphere = createAtmosphereHandlers();

export function GET(request: Request): Promise<Response> {
  return atmosphere.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return atmosphere.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return atmosphere.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return atmosphere.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return atmosphere.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return atmosphere.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return atmosphere.methodNotAllowed(request);
}
