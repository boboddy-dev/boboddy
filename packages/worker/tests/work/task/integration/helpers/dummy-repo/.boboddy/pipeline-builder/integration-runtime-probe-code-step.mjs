function integrationRuntimeProbeCodeStep() {
  return {
    summary: "probed runtime",
    bunVersion: process.versions.bun ?? null,
    nodeVersion: process.versions.node ?? null,
    cwd: process.cwd(),
  };
}

export const runtimeProbeStep = {
  key: "integration-step",
  name: "Integration Step",
  version: 1,
  kind: "code",
  entrypoint: { fn: integrationRuntimeProbeCodeStep },
};
