// Vercel Function (Node.js runtime, Web handlers): the weather report's Open Graph card,
// drawn from the weather right now (server/og-weather.ts). vercel.json rewrites
// /og/weather.png here.
//   GET / HEAD ?card=forecast|trend|mix|today|hosts|migration  -> image/png, 1200x630
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createOgWeatherHandlers } from '../server/og-weather.js';

const og = createOgWeatherHandlers();

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
