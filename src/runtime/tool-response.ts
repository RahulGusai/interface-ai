import {
  dispatchErrorSchema,
  toolResultSchemas,
  type ToolName,
  type ToolResponse,
} from "../contracts/tools.js";

/** Validate protocol shape and image correlation without applying exposure rules. */
export function validateToolResponse(
  name: ToolName,
  response: ToolResponse,
): ToolResponse {
  const result = dispatchErrorSchema.safeParse(response.result).success
    ? dispatchErrorSchema.parse(response.result)
    : toolResultSchemas[name].parse(response.result);
  const observation =
    "observation" in result
      ? result.observation
      : result.status === "ok"
        ? result
        : undefined;
  if (
    observation?.status === "ok" &&
    observation.screenshot.status === "available"
  ) {
    if (
      !response.image?.bytes.length ||
      response.image.ref !== observation.screenshot.image_ref
    )
      throw Error("Missing image bytes");
    return { result, image: response.image };
  }
  return { result };
}
