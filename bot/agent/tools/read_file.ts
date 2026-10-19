import { defineTool } from "eve/tools";
import { readFile } from "eve/tools/read_file";
import { refuseWebsiteCaller } from "../lib/website";

// eve's own read_file for every caller except a website visitor, who gets an
// error instead. See refuseWebsiteCaller in lib/website.ts.
export default defineTool({
  ...readFile,
  execute(input, ctx) {
    refuseWebsiteCaller(ctx, "read_file");
    return readFile.execute(input, ctx);
  },
});
