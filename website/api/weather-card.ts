// Vercel Function (Node.js runtime, Web handlers): the weather report's Open Graph card,
// drawn from the live reading (see server/weather-card.ts). vercel.json serves it at
// /weather/card.png and includes the fonts and art it reads.
//   GET / HEAD  -> image/png, 1200x630
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createCardHandlers } from '../server/weather-card.js';

const card = createCardHandlers();

export function GET(request: Request): Promise<Response> {
  return card.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return card.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return card.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return card.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return card.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return card.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return card.methodNotAllowed(request);
}
