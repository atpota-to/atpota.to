// Vercel Function (Node.js runtime, Web handlers): Poe's blog, server-rendered from
// standard.site records (see server/blog/handler.ts for the routes vercel.json sends here).
//   GET / HEAD  -> the page, feed or well-known answer
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createBlogHandlers } from '../server/blog/handler.js';

const blog = createBlogHandlers();

export function GET(request: Request): Promise<Response> {
  return blog.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return blog.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return blog.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return blog.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return blog.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return blog.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return blog.methodNotAllowed(request);
}
