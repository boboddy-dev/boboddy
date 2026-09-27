import { describe, expect, test } from "bun:test";
import { classifyArtifactSaveError } from "../../../../src/artifacts/artifact-store/domain/classify-artifact-save-error";

describe("classifyArtifactSaveError", () => {
  test("classifies a plane-client problem-details error, preferring code/detail", () => {
    const error = new Error(
      JSON.stringify({
        type: "urn:problem-type:boboddy:api:http-402",
        title: "Request Failed",
        status: 402,
        detail: "Usage limit exceeded for storage",
        instance: "/api/step-executions/abc/artifact-upload-url",
        code: "USAGE_LIMIT_EXCEEDED_STORAGE",
      }),
    );

    expect(classifyArtifactSaveError(error)).toEqual({
      errorCode: "USAGE_LIMIT_EXCEEDED_STORAGE",
      errorMessage: "Usage limit exceeded for storage",
      httpStatus: 402,
    });
  });

  test("falls back to title when detail is missing", () => {
    const error = new Error(
      JSON.stringify({
        type: "urn:problem-type:boboddy:api:http-404",
        title: "Not Found",
        status: 404,
        code: "STEP_EXECUTION_NOT_FOUND",
      }),
    );

    expect(classifyArtifactSaveError(error)).toEqual({
      errorCode: "STEP_EXECUTION_NOT_FOUND",
      errorMessage: "Not Found",
      httpStatus: 404,
    });
  });

  test("falls back to a generic HTTP error code when the payload has a status but no code", () => {
    const error = new Error(JSON.stringify({ status: 500 }));

    const result = classifyArtifactSaveError(error);
    expect(result.errorCode).toBe("UPLOAD_HTTP_ERROR");
    expect(result.httpStatus).toBe(500);
  });

  test("never throws on a non-JSON Error message and classifies as UNKNOWN", () => {
    const error = new Error("ECONNRESET: socket hang up");

    expect(classifyArtifactSaveError(error)).toEqual({
      errorCode: "UNKNOWN",
      errorMessage: "ECONNRESET: socket hang up",
      httpStatus: null,
    });
  });

  test("never throws on a non-Error throw", () => {
    expect(classifyArtifactSaveError("just a string")).toEqual({
      errorCode: "UNKNOWN",
      errorMessage: "just a string",
      httpStatus: null,
    });
  });

  test("never throws on JSON that parses to a non-object", () => {
    const error = new Error("42");

    expect(classifyArtifactSaveError(error)).toEqual({
      errorCode: "UNKNOWN",
      errorMessage: "42",
      httpStatus: null,
    });
  });

  test("caps errorMessage length at 1000 characters", () => {
    const longDetail = "x".repeat(2000);
    const error = new Error(
      JSON.stringify({ status: 400, code: "BAD_REQUEST", detail: longDetail }),
    );

    const result = classifyArtifactSaveError(error);
    expect(result.errorMessage.length).toBe(1000);
  });
});
