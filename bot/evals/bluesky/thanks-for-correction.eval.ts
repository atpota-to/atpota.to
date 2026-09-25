import { defineEval } from "eve/evals";
import { VOICE, assertBlueskyPost, mention } from "./shared";

/** The real reply was "got it, and it's noted." */
export default defineEval({
  description: "Corrected by the people who run it, Poe thanks them and fixes it.",
  tags: ["bluesky", "voice"],
  async test(t) {
    await t.send(
      mention(
        "remember: the person you're replying to is on an independent PDS host, so they " +
          "should use their host's account page. emailing bluesky support won't apply to them.",
        {
          authorDid: "did:plc:gq4fo3u6tqzzdkjlwzpb23tj",
          authorHandle: "dame.is",
          operator: true,
          lessonSaved:
            "People on an independent PDS delete their account on their host's account page, not through Bluesky support.",
          thread: [
            { author: "someone.example", authorDid: "did:plc:evalasker", you: false,
              text: "how do i delete my account? please help" },
            { author: "poe.atpota.to", authorDid: "did:plc:6qw63oash3jfnpykvpbwnq5z", you: true,
              text: "settings > account > delete account. if it won't go through, support@bsky.app" },
          ],
        },
      ),
    );
    t.succeeded();
    assertBlueskyPost(t);
    t.judge.autoevals
      .closedQA(
        "thanks the person warmly for the correction and restates the corrected advice " +
          "about using the PDS host's account page",
      )
      .label("glad to be corrected")
      .atLeast(0.8);
    t.judge.autoevals.closedQA(VOICE).label("voice").atLeast(0.7);
  },
});
