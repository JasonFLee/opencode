import { Effect, Schema } from "effect"
import { DecisionModel, type DecisionRequestFor, type DecisionResponse } from "../decision.js"
import { Endpoint } from "../route/endpoint.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import type { ProviderID } from "../schema/index.js"
import { SystemOne } from "./system-one.js"

// Workers AI models answer with the System One response; third-party models such as TypeSafe Jev wrap it in a
// completed run record.
const Envelope = Schema.Struct({
  result: Schema.Union([
    SystemOne.Response,
    Schema.Struct({ state: Schema.Literal("Completed"), result: SystemOne.Response }),
  ]),
})

export interface ModelInput extends MediaRoute.ModelInput {
  /** Also the provider metadata key. */
  readonly provider: ProviderID
  /** The Run API base, `.../client/v4/accounts/{account}/ai/run`. */
  readonly baseURL: string
}

/**
 * Posts `{ model, input }` to Cloudflare's `/ai/run` with the System One body as `input`. Media goes in Clef's
 * top-level `images`, `audio` and `videos` lists.
 */
export const model = (input: ModelInput) => {
  const route = MediaProtocol.identity({
    id: "cloudflare-run-decisions",
    name: "Cloudflare Run",
    provider: input.provider,
  })
  const decode = route.decodeJson(Envelope)
  const composed = MediaRoute.inline({
    protocol: MediaProtocol.inline<DecisionRequestFor, DecisionResponse>(route, {
      body: {
        from: (request) =>
          SystemOne.encodeBody(request, "images").pipe(
            Effect.map((body) => MediaProtocol.json({ model: request.model.id, input: body })),
          ),
      },
      response: {
        decode: (response, context) =>
          decode(response).pipe(
            Effect.flatMap((output) =>
              SystemOne.toResponse(
                "answers" in output.value.result ? output.value.result : output.value.result.result,
                context.request,
                input.provider,
                output.invalid,
              ),
            ),
          ),
      },
    }),
    endpoint: Endpoint.path<MediaProtocol.Body, DecisionRequestFor>("", { baseURL: input.baseURL }),
    auth: input.auth,
    headers: input.headers,
  })
  return DecisionModel.make({
    id: input.id,
    provider: input.provider,
    http: input.http,
    route: { id: composed.id, inlineMedia: true, generate: composed.generate },
  })
}

export const CloudflareRunDecisions = { model } as const
