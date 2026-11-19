// Vercel Function (Node.js runtime, Web handlers): the admin page's proxy (server/admin.ts).
//   GET  ?view=overview | history | person | digest   -> JSON
//   POST { target: memory | restore | guidance | nap } -> JSON
//   anything else -> 405
// Only for a signed-in admin or Poe itself, with a to.atpota.poe.admin token.
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createAdminHandlers } from '../server/admin.js';

const admin = createAdminHandlers();

export function GET(request: Request): Promise<Response> {
  return admin.GET(request);
}

export function POST(request: Request): Promise<Response> {
  return admin.POST(request);
}

export function PUT(request: Request): Promise<Response> {
  return admin.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return admin.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return admin.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return admin.methodNotAllowed(request);
}
