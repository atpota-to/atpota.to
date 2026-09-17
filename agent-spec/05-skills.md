# 05. Skills

eve scans `agent/skills/`, shows the model each skill's `description`, and pulls
the body into context only when the model calls `load_skill`. That makes skills
the right home for procedures that matter on some turns and would be dead weight
on the rest.

Everything in [`skills/`](skills/) is a flat markdown file with `description`
frontmatter. Drop them into `agent/skills/` unchanged; the filename becomes the
skill name.

| Skill | Loads when | Why it is a skill and not instructions |
| --- | --- | --- |
| `resolve-anything` | The visitor pastes or names an identifier of any kind | The identifier taxonomy is long and only matters when there is an identifier |
| `explain-to-a-newcomer` | Someone asks what a thing is in plain terms | The vocabulary ladder is a procedure, and using it on a builder would be condescending |
| `identity-doctor` | Handle broke, account moved, DID looks wrong | Troubleshooting sequence, rarely needed, expensive to carry |
| `repo-archaeology` | "What's in my repo", "what is this app writing" | Collection-by-collection reasoning that only applies to repo questions |
| `backlink-detective` | "Who linked to this, from any app" | The cross-app framing is the thing most people have never seen and needs its own explanation |
| `builder-lookup` | Lexicon schemas, API methods, NSIDs | Precision-mode behavior that would flatten the voice if it were always on |
| `find-your-people` | Feeds, starter packs, lists, labelers | Discovery has its own etiquette, especially around labelers |
| `bluesky-reply` | Always on for Bluesky sessions, loadable elsewhere | Length and etiquette rules that are wrong on the website, so they are channel-scoped rather than carried in the main prompt |
| `house-facts` | Ecosystem facts the tools do not return well | Not yet written. This is where curated shared knowledge lives instead of in a shared memory slot, for the reasons in [`10-memory.md`](10-memory.md) |

## The routing tradeoff

The tool routing table in `04-aturi-connection.md` is needed on nearly every
turn, which makes it a poor fit for on-demand loading. Two options:

- **Start by inlining a compressed version of it into `agent/instructions.md`.**
  Costs maybe 150 words on every call and removes a whole class of failure.
- **Or keep it in a skill** named so obviously that the model always loads it.
  Cheaper per turn, but a skipped `load_skill` means a badly routed answer.

Recommendation: inline the compressed table, keep the full one in the connection
doc for humans, and let `08-evals.md` tell you if the model is still routing
badly.

## Writing more skills later

Two rules from eve's docs that are easy to get wrong:

- The `description` is a routing trigger, not a label. Write it as the situation
  that should activate it ("Use when the visitor pastes an at:// URI or a handle
  and wants to know what it is"), not as a topic ("Identifiers").
- Loading a skill adds instructions, never a new capability. If you find yourself
  wanting a skill to *do* something, you want a tool.
