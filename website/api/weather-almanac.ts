// Vercel Function (Node.js runtime, Web handlers): the weather report's almanac
// (today's high and low, compared to usual, new apps, the week's heat map, the station's records;
// see server/weather-almanac.ts).
//   GET / HEAD ?tz=<IANA zone>  -> { tz, today?, normal?, newApps?, heatmap?, records? }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createAlmanacHandlers } from '../server/weather-almanac.js';

const almanac = createAlmanacHandlers();

export function GET(request: Request): Promise<Response> {
  return almanac.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return almanac.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return almanac.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return almanac.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return almanac.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return almanac.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return almanac.methodNotAllowed(request);
}
