// Markdown assets are imported with `with { type: "text" }` so `bun build
// --compile` inlines them into the binary as strings (same mechanism as
// `*.tmpl`, declared in ./tmpl.d.ts).
declare module "*.md" {
  const content: string;
  export default content;
}
