/**
 * Runtime validator for OpenCode config documents, built from the
 * `components.schemas` vendored out of a real `opencode serve`'s
 * `/openapi.json` (re-vendor with `vendor-opencode-openapi.ts`).
 *
 * Overlays are serialized with `JSON.stringify`, so their TypeScript types say
 * little about what reaches the runtime. Validating the serialized document
 * against `Config.InfoEncoded` catches shape errors the compiler cannot.
 */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { OPENCODE_RUNTIME_VERSION } from "../../src/runtime/runtime-service/domain/opencode-runtime-payload";
import { vendoredOpenapiFixturePath } from "./vendor-opencode-openapi";

const DOCUMENT_ID = "opencode-openapi";

export type ConfigSchemaCheck = { valid: boolean; errors: string };

export type OpencodeConfigDocument = Readonly<Record<string, unknown>>;

export type ConfigSchemaValidator = (
  document: OpencodeConfigDocument,
) => ConfigSchemaCheck;

/**
 * The vendored document is registered under {@link DOCUMENT_ID}, so its own
 * `#/components/schemas/<Name>` refs resolve within it unchanged.
 */
export function buildOpencodeConfigValidator(): ConfigSchemaValidator {
  const vendored: unknown = JSON.parse(
    readFileSync(vendoredOpenapiFixturePath(OPENCODE_RUNTIME_VERSION), "utf8"),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(vendored as object, DOCUMENT_ID);
  const validate = ajv.compile({
    $ref: `${DOCUMENT_ID}#/components/schemas/Config.InfoEncoded`,
  });
  return (document) => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(document));
    const valid = validate(roundTripped);
    return { valid, errors: ajv.errorsText(validate.errors) };
  };
}
