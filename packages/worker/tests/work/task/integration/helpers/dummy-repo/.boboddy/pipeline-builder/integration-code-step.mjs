export default {
  key: "integration-pipeline",
  name: "Integration pipeline",
  version: 1,
  nodeDefinitions: [],
  _stepDefinitions: [
    {
      key: "integration-step",
      name: "Integration Step",
      version: 1,
      kind: "code",
      entrypoint: {
        fn: (input) => ({ summary: "code step ok", node: process.version, input }),
      },
    },
  ],
};
