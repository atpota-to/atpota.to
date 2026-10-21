// Vercel Function (Node.js runtime, Web handlers): the garden's leaderboards, for the community
// garden page: most flowers, most tending for others, most pets for Poe, most kinds found and
// most visitors (see server/leaderboard.ts).
//   GET / HEAD  -> { boards: { flowers, tending, pets, kinds, visitors }, updatedAt }
//   anything else -> 405
// Local imports end in ".js": Vercel runs the compiled files as native ESM.

import { createLeaderboardHandlers } from '../server/leaderboard.js';

const leaderboard = createLeaderboardHandlers();

export function GET(request: Request): Promise<Response> {
  return leaderboard.GET(request);
}

export function HEAD(request: Request): Promise<Response> {
  return leaderboard.HEAD(request);
}

export function POST(request: Request): Promise<Response> {
  return leaderboard.methodNotAllowed(request);
}

export function PUT(request: Request): Promise<Response> {
  return leaderboard.methodNotAllowed(request);
}

export function PATCH(request: Request): Promise<Response> {
  return leaderboard.methodNotAllowed(request);
}

export function DELETE(request: Request): Promise<Response> {
  return leaderboard.methodNotAllowed(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return leaderboard.methodNotAllowed(request);
}
