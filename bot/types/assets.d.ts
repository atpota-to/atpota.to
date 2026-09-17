/**
 * eve resolves `?raw` asset imports at compile and build time but ships no
 * ambient declaration for them, so declare the ones this project uses.
 * See node_modules/eve/docs/reference/typescript-api.md.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
