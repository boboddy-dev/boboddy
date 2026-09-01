// `App.tsx` imports `@xyflow/react/dist/style.css` for its side effect only
// (Bun's bundler resolves and emits it as a real CSS asset — see `build.ts`).
// TypeScript has no built-in module type for `.css`; this ambient
// declaration is the standard shim for side-effect CSS imports in a
// standalone (non-Next) React app.
declare module "*.css";
