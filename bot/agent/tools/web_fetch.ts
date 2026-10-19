import { defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";
import { refuseWebsiteCaller } from "../lib/website";

// eve's own web_fetch for every caller except a website visitor, who gets an
// error instead. See refuseWebsiteCaller in lib/website.ts.
export default defineTool({
  ...webFetch,
  execute(input, ctx) {
    refuseWebsiteCaller(ctx, "web_fetch");
    return webFetch.execute(input, ctx);
  },
});
