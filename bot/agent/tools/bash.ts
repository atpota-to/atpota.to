import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";
import { refuseWebsiteCaller } from "../lib/website";

// eve's own bash for every caller except a website visitor, who gets an
// error instead. See refuseWebsiteCaller in lib/website.ts.
export default defineTool({
  ...bash,
  execute(input, ctx) {
    refuseWebsiteCaller(ctx, "bash");
    return bash.execute(input, ctx);
  },
});
