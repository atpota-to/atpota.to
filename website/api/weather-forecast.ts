// Vercel Function (Node.js runtime, Web handlers): the weather report's forecast for the
// next 12 hours, with its likely ranges, chances of gusts and storms, the network's sunrise
// and sunset, and how close it's been (see server/weather-forecast.ts).
//   GET / HEAD  -> { madeAt, basis, now, hours, sun, skill? } or { madeAt, basis, learning: true }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createForecastHandlers } from '../server/weather-forecast.js';

const forecast = createForecastHandlers();

export function GET(request: Request): Promise<Response> {
  return forecast.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return forecast.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return forecast.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return forecast.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return forecast.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return forecast.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return forecast.methodNotAllowed(request);
}
