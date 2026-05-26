import { describe, expect, test, vi } from "bun:test";
import { pushPipelineDefinitions } from "../../../../src/pipelines/pipeline-definitions/application/push-pipeline-definitions";
import type { PipelineDefinitionSpec } from "@boboddy/sdk/definitions/pipelines";

function makeLogger() {
  return { info: vi.fn() };
}

function makeListByProjectId(keys: string[] = []) {
  return vi.fn(() => Promise.resolve(keys.map((key) => ({ key }))));
}

function makeUpsertFromSpec() {
  return vi.fn(() => Promise.resolve({}));
}

function makeClient(
  upsertFromSpec = makeUpsertFromSpec(),
  listByProjectId = makeListByProjectId(),
) {
  return vi.fn(() => ({
    listByProjectId,
    upsertFromSpec,
  }));
}

const ADVANCEMENT_POLICY = {
  rulesJson: { rules: [] },
  defaultEventType: "continue" as const,
  defaultEventParamsJson: null,
  allowedEventTypes: ["continue" as const],
};

function makeSpec(overrides?: Partial<PipelineDefinitionSpec>): PipelineDefinitionSpec {
  return {
    key: "my-pipeline",
    name: "My Pipeline",
    description: null,
    version: 1,
    status: "active",
    steps: [
      {
        stepKey: "step-a",
        stepName: "Step A",
        stepDescription: null,
        position: 0,
        inputBindingsJson: {},
        timeoutSeconds: null,
        advancementPolicyDefinition: ADVANCEMENT_POLICY,
        computedSignalDefinitions: [],
      },
    ],
    ...overrides,
  };
}

describe("pushPipelineDefinitions", () => {
  test("calls upsertFromSpec with projectId, spec, and the step def list", async () => {
    const upsertFromSpec = makeUpsertFromSpec();
    const createClient = makeClient(upsertFromSpec);

    const stepDefs = [{ id: "step-def-id", key: "step-a", version: 1 }];
    const spec = makeSpec();

    await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs: [spec],
      stepDefs,
      createClient,
    });

    expect(upsertFromSpec).toHaveBeenCalledTimes(1);
    expect(upsertFromSpec).toHaveBeenCalledWith(
      "proj-1",
      spec,
      stepDefs,
      { headers: { Authorization: "Bearer token" } },
    );
  });

  test("calls upsertFromSpec once per spec", async () => {
    const upsertFromSpec = makeUpsertFromSpec();
    const createClient = makeClient(upsertFromSpec);

    const specs = [
      makeSpec({ key: "pipeline-a" }),
      makeSpec({ key: "pipeline-b" }),
    ];

    await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs,
      stepDefs: [{ id: "step-def-id", key: "step-a", version: 1 }],
      createClient,
    });

    expect(upsertFromSpec).toHaveBeenCalledTimes(2);
  });

  test("throws when a step routes to an unknown pipeline key", async () => {
    const upsertFromSpec = makeUpsertFromSpec();
    const createClient = makeClient(upsertFromSpec, makeListByProjectId([]));

    const spec = makeSpec({
      steps: [
        {
          stepKey: "step-a",
          stepName: "Step A",
          stepDescription: null,
          position: 0,
          inputBindingsJson: {},
          timeoutSeconds: null,
          advancementPolicyDefinition: {
            rulesJson: { rules: [] },
            defaultEventType: "route",
            defaultEventParamsJson: { pipelineKey: "missing-pipeline" },
            allowedEventTypes: ["route", "continue"],
          },
          computedSignalDefinitions: [],
        },
      ],
    });

    let caughtError: unknown;
    try {
      await pushPipelineDefinitions({
        projectId: "proj-1",
        baseUrl: "https://example.com",
        headers: { Authorization: "Bearer token" },
        logger: makeLogger(),
        specs: [spec],
        stepDefs: [{ id: "step-def-id", key: "step-a", version: 1 }],
        createClient,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain(
      'routes to pipeline "missing-pipeline"',
    );
    expect(upsertFromSpec).not.toHaveBeenCalled();
  });

  test("allows a step to route to a pipeline being pushed in the same batch", async () => {
    const upsertFromSpec = makeUpsertFromSpec();
    const createClient = makeClient(upsertFromSpec, makeListByProjectId([]));

    const routing = makeSpec({
      key: "router",
      steps: [
        {
          stepKey: "step-a",
          stepName: "Step A",
          stepDescription: null,
          position: 0,
          inputBindingsJson: {},
          timeoutSeconds: null,
          advancementPolicyDefinition: {
            rulesJson: { rules: [] },
            defaultEventType: "route",
            defaultEventParamsJson: { pipelineKey: "destination" },
            allowedEventTypes: ["route", "continue"],
          },
          computedSignalDefinitions: [],
        },
      ],
    });
    const destination = makeSpec({ key: "destination" });

    await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs: [routing, destination],
      stepDefs: [{ id: "step-def-id", key: "step-a", version: 1 }],
      createClient,
    });

    expect(upsertFromSpec).toHaveBeenCalledTimes(2);
  });

  test("allows a step to route to a pipeline that exists on the server", async () => {
    const upsertFromSpec = makeUpsertFromSpec();
    const createClient = makeClient(
      upsertFromSpec,
      makeListByProjectId(["existing-destination"]),
    );

    const routing = makeSpec({
      steps: [
        {
          stepKey: "step-a",
          stepName: "Step A",
          stepDescription: null,
          position: 0,
          inputBindingsJson: {},
          timeoutSeconds: null,
          advancementPolicyDefinition: {
            rulesJson: { rules: [] },
            defaultEventType: "route",
            defaultEventParamsJson: { pipelineKey: "existing-destination" },
            allowedEventTypes: ["route", "continue"],
          },
          computedSignalDefinitions: [],
        },
      ],
    });

    await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs: [routing],
      stepDefs: [{ id: "step-def-id", key: "step-a", version: 1 }],
      createClient,
    });

    expect(upsertFromSpec).toHaveBeenCalledTimes(1);
  });

  test("returns the count of pushed pipeline definitions", async () => {
    const specs = [makeSpec({ key: "p-1" }), makeSpec({ key: "p-2" })];

    const result = await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs,
      stepDefs: [{ id: "step-def-id", key: "step-a", version: 1 }],
      createClient: makeClient(),
    });

    expect(result).toEqual({ pushed: 2 });
  });

  test("returns zero pushed when specs list is empty and skips server roundtrip", async () => {
    const upsertFromSpec = makeUpsertFromSpec();
    const listByProjectId = makeListByProjectId();
    const createClient = makeClient(upsertFromSpec, listByProjectId);

    const result = await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs: [],
      stepDefs: [],
      createClient,
    });

    expect(result).toEqual({ pushed: 0 });
    expect(listByProjectId).not.toHaveBeenCalled();
    expect(upsertFromSpec).not.toHaveBeenCalled();
  });

  test("instantiates the client with the given baseUrl", async () => {
    const createClient = makeClient();

    await pushPipelineDefinitions({
      projectId: "proj-1",
      baseUrl: "https://my-server.example.com",
      headers: { Authorization: "Bearer token" },
      logger: makeLogger(),
      specs: [makeSpec()],
      stepDefs: [{ id: "step-def-id", key: "step-a", version: 1 }],
      createClient,
    });

    expect(createClient).toHaveBeenCalledWith("https://my-server.example.com");
  });
});
