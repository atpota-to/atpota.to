// Vercel Function (Node.js runtime, Web handlers): the weather report's "last minute" tile
// over an hour, a day or a week, and the stretch before it (see server/weather-span.ts).
//   GET / HEAD ?span=minute|hour|day|week  -> { span, now?, before }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createSpanHandlers } from '../server/weather-span.js';

const span = createSpanHandlers();

export function GET(request: Request): Promise<Response> {
  return span.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return span.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return span.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return span.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return span.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return span.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return span.methodNotAllowed(request);
}
