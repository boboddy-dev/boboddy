/**
 * Awaits a promise that is expected to reject and returns the error, so a test
 * can assert on its type and message. Fails the test when the promise resolves.
 */
export async function captureRejection(
  promise: Promise<unknown>,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the promise to reject, but it resolved");
}
