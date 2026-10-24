import { Effect, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"
import {
  DecisionModel,
  DecisionResponse,
  type DecisionAnswer,
  type DecisionPart,
  type DecisionRequestFor,
} from "../decision.js"
import { Endpoint } from "../route/endpoint.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import { ProviderID, mergeJsonRecords, type AIError, type OpenString } from "../schema/index.js"
import { encodeJson } from "../utils/json.js"
import { OpenResponses } from "./open-responses.js"
import { ProviderShared } from "./shared.js"

const route = MediaProtocol.identity({ id: "openai-decisions", name: "OpenAI Decisions", provider: "openai" })
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/decisions"

/** Known fields map to their wire names; anything else is sent as given. */
export type OpenAIDecisionOptions = {
  readonly promptCacheKey?: string
  readonly promptCacheOptions?: Readonly<{ mode?: OpenString<"implicit" | "explicit">; ttl?: OpenString<"30m"> }>
  readonly safetyIdentifier?: string
} & Record<string, unknown>

export type Request = DecisionRequestFor<OpenAIDecisionOptions>

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const ChoiceValue = Schema.Union([Schema.String, Schema.Boolean])
const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("predicate"), name: Schema.String, probability: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    name: Schema.String,
    choice: ChoiceValue,
    probabilities: Schema.Array(Schema.Struct({ value: ChoiceValue, probability: Probability })),
    confidence: Probability,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    name: Schema.String,
    score: Schema.Number,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.Int, label: Schema.String, probability: Probability })),
    confidence: Probability,
  }),
  Schema.Struct({ type: Schema.Literal("refusal"), name: Schema.String }),
])
const Response = Schema.Struct({
  model: Schema.String,
  answers: Schema.Array(Answer),
  usage: Schema.optional(OpenResponses.OpenResponsesUsage),
})

const fromRequest = Effect.fn("OpenAIDecisions.fromRequest")(function* (request: Request) {
  return MediaProtocol.json({
    ...mergeJsonRecords(nativeOptions(request.providerOptions), request.http?.body),
    model: request.model.id,
    input: [{ role: "user", content: yield* Effect.forEach(request.input, inputPart) }],
    questions: request.questions,
  })
})

const nativeOptions = (options: OpenAIDecisionOptions | undefined) => {
  if (!options) return undefined
  const { promptCacheKey, promptCacheOptions, safetyIdentifier, ...native } = options
  return {
    prompt_cache_key: promptCacheKey,
    prompt_cache_options: promptCacheOptions,
    safety_identifier: safetyIdentifier,
    ...native,
  }
}

// `input_json` takes an object or a list of objects; other JSON values go as text.
const inputPart = (part: DecisionPart): Effect.Effect<Record<string, unknown>, AIError> => {
  if (part.type === "text") return Effect.succeed({ type: "input_text", text: part.text })
  if (part.type === "json")
    return Effect.succeed(
      isObject(part.value) || (Array.isArray(part.value) && part.value.every(isObject))
        ? { type: "input_json", data: part.value }
        : { type: "input_text", text: encodeJson(part.value) },
    )
  if (part.media.kind !== "image")
    return Effect.fail(
      route.unsupported("decision.media", `${route.name} takes images only; got ${part.media.kind} media`),
    )
  return ProviderShared.mediaReference(part.media, undefined, `${route.name} image input`).pipe(
    Effect.map((reference) => ({ type: "input_image", image_url: reference.value })),
  )
}

const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value)

const decodeDocument = route.decodeJson(Response)

const decodeResponse = (provider: ProviderID) =>
  Effect.fn("OpenAIDecisions.decodeResponse")(function* (
    response: HttpClientResponse.HttpClientResponse,
    context: MediaProtocol.DecodeContext<Request>,
  ) {
    const output = yield* decodeDocument(response)
    const answers = output.value.answers.map(
      (answer): DecisionAnswer =>
        answer.type === "refusal" ? { name: answer.name, type: "error", reason: "refusal" } : answer,
    )
    const byName = new Map(answers.map((answer) => [answer.name, answer]))
    const ordered = context.request.questions.flatMap((question) => byName.get(question.name) ?? [])
    return new DecisionResponse({
      answers: ordered.length === answers.length ? ordered : answers,
      usage: OpenResponses.mapUsage(output.value.usage, provider),
      providerMetadata: { [provider]: { model: output.value.model } },
    })
  })

export const protocol = MediaProtocol.inline<Request, DecisionResponse>(route, {
  body: { from: fromRequest },
  response: { decode: decodeResponse(route.provider) },
})

/** `provider` attributes the model and its metadata to an OpenAI-compatible host; it defaults to `openai`. */
export const model = (input: MediaRoute.ModelInput & { readonly provider?: string }) => {
  const provider = ProviderID.make(input.provider ?? route.provider)
  const composed = MediaRoute.inline({
    protocol: { ...protocol, provider, response: { decode: decodeResponse(provider) } },
    endpoint: Endpoint.path<MediaProtocol.Body, Request>(PATH, { baseURL: input.baseURL ?? DEFAULT_BASE_URL }),
    auth: input.auth,
    headers: input.headers,
  })
  return DecisionModel.make<OpenAIDecisionOptions>({
    id: input.id,
    provider,
    http: input.http,
    route: { id: composed.id, generate: composed.generate },
  })
}

export const OpenAIDecisions = {
  protocol,
  model,
} as const
