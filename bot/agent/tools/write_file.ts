import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/write_file";
import { refuseWebsiteCaller } from "../lib/website";

// eve's own write_file for every caller except a website visitor, who gets an
// error instead. See refuseWebsiteCaller in lib/website.ts.
export default defineTool({
  ...writeFile,
  execute(input, ctx) {
    refuseWebsiteCaller(ctx, "write_file");
    return writeFile.execute(input, ctx);
  },
});
