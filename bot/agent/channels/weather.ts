import { defineChannel, POST } from "eve/channels";
import { MAX_TRACKED_LINKS, linksFromToolResult, secretMatches } from "../lib/bluesky";
import { WeatherMoment, buildWeatherPrompt, postWeatherDraft } from "../lib/weather-post";

/**
 * Weather moments from the droplet's weather watcher (mentions/src/weather-posts.js):
 * one session per moment, nobody on the other end but the droplet, and the answer is
 * a draft post for Poe's own Bluesky account (or "skip"). The droplet gates it and
 * posts it; see lib/weather-post.ts.
 */
export default defineChannel({
  turnPolicy: "queue",
  audience: () => "public",
  state: { draft: "", links: [] as string[] },
  context(state) {
    return { state };
  },
  routes: [
    POST("/weather/moment", async (request, { from, waitUntil }) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) {
        return new Response(null, { status: 401 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      const parsed = WeatherMoment.safeParse(body);
      if (!parsed.success) return new Response(null, { status: 400 });
      const moment = parsed.data;

      waitUntil(from(moment.momentId).send(buildWeatherPrompt(moment), {
        auth: {
          authenticator: "atpotato-droplet-weather",
          principalType: "service",
          principalId: "atpotato-weather-watch",
          attributes: { momentId: moment.momentId, kind: moment.kind },
        },
      }).then(() => undefined));
      return new Response(null, { status: 202 });
    }),
  ],
  events: {
    "turn.started"(_event, channel) {
      channel.state.draft = "";
      channel.state.links = [];
    },
    // The droplet allows one link in a weather post, the weather page's, and checks it
    // against these: every URL a tool returned this turn.
    "action.result"(event, channel) {
      if (channel.state.links.length >= MAX_TRACKED_LINKS) return;
      const merged = new Set(channel.state.links);
      for (const url of linksFromToolResult(event)) merged.add(url);
      channel.state.links = [...merged].slice(0, MAX_TRACKED_LINKS);
    },
    "message.completed"(event, channel) {
      if (event.message) channel.state.draft = event.message;
    },
    async "turn.completed"(event, channel, ctx) {
      const caller = ctx.session.auth.current;
      const momentId = caller?.attributes?.momentId;
      if (caller?.authenticator !== "atpotato-droplet-weather" || typeof momentId !== "string" ||
          channel.continuation?.token !== momentId) return;
      const text = channel.state.draft.trim();
      if (!text) return;
      await postWeatherDraft({
        key: `${ctx.session.id}:${event.turnId}`,
        momentId,
        text,
        links: channel.state.links,
      });
    },
  },
});
