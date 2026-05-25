# boboddy

### Business Oriented Bug Optimization & Diagnostic Deployment sYstem

A distributed workflow platform for running AI-powered pipelines at scale.

You define **steps** (typed units of work) and wire them into **pipelines** that automatically advance based on extracted signals — numeric or boolean metrics pulled from each step's output. Workers running on any machine claim step executions, run them inside Docker containers with an AI agent, and report results back. Signal-driven advancement policies decide whether to continue to the next stage.

Because workers run on your own machines and you bring your own AI provider, your code and data never leave your infrastructure. No third-party execution environment, no shared compute — full control over security and cost.

The result: multi-step AI workflows that are type-safe, scalable, and require no custom orchestration infrastructure.

**[boboddy.vercel.app](https://boboddy.vercel.app)** — [Docs](https://connorivy.github.io/boboddy/)
