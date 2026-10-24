import { Effect, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"
import {
  DecisionModel,
  DecisionResponse,
  type DecisionAnswer,
  type DecisionOptions,
  type DecisionPart,
  type DecisionQuestion,
  type DecisionRequestFor,
} from "../decision.js"
import type { Media } from "../media.js"
import { Endpoint } from "../route/endpoint.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import { ProviderID, Usage, mergeJsonRecords, type AIError } from "../schema/index.js"
import { JsonObject, ProviderShared } from "./shared.js"

export const DEFAULT_PATH = "/systemone"

/**
 * Where a host reads images, from models.dev `[api.systemone] compatibility.image_input`:
 * - `assets`: TypeSafe's `assets` map, referenced from the state, with its opt-in header (always sent: it changes
 *   nothing for requests without images, checked live);
 * - `images`: top-level `images` (plus `audio` and `videos`) lists in input order;
 * - `state`: `image_url` (plus `input_audio` and `video_url`) items in place inside a `state` list.
 */
export type ImageInput = "assets" | "images" | "state"

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Schema.Record(Schema.String, Probability),
    confidence: Probability,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    probabilities: Schema.Record(Schema.String, Probability),
    confidence: Probability,
  }),
]).pipe(Schema.toTaggedUnion("type"))
const NativeUsage = Schema.StructWithRest(
  Schema.Struct({
    input_tokens: Schema.optional(Schema.Number),
    output_tokens: Schema.optional(Schema.Number),
  }),
  [JsonObject],
)
export const Response = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.optional(NativeUsage),
  id: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  provider_metadata: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
})
export type Response = Schema.Schema.Type<typeof Response>

const route = MediaProtocol.identity({ id: "system-one", name: "System One", provider: "system-one" })

/** The System One body without `model`. */
export const encodeBody = Effect.fn("SystemOne.encodeBody")(function* (
  request: DecisionRequestFor,
  imageInput: ImageInput,
) {
  const questions = yield* encodeQuestions(request.questions)
  const placed = yield* placeMedia(request.input, imageInput)
  return { ...mergeJsonRecords(request.providerOptions, request.http?.body), ...placed, questions }
})

const encodeQuestions = (questions: ReadonlyArray<DecisionQuestion>) =>
  Effect.forEach(questions, (question): Effect.Effect<readonly [string, unknown], AIError> => {
    if (question.type === "predicate")
      return Effect.succeed([question.name, { type: "noul", instructions: question.instructions }] as const)
    if (question.type === "score")
      return Effect.succeed([
        question.name,
        {
          type: "score",
          instructions: question.instructions,
          criteria: question.levels.map((level) =>
            level.description === undefined ? level.label : `${level.label}: ${level.description}`,
          ),
        },
      ] as const)
    // Options are map keys, so `true` is sent as "true" and mapped back by `choiceValue`.
    const keys = question.choices.map((choice) => String(choice.value))
    if (new Set(keys).size !== keys.length)
      return Effect.fail(
        ProviderShared.invalidRequest(
          `System One choice options are strings; "${question.name}" has a boolean and a string with the same text`,
        ),
      )
    return Effect.succeed([
      question.name,
      {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.choices.map((choice) => [String(choice.value), choice.description ?? null]),
        ),
      },
    ] as const)
  }).pipe(Effect.map(Object.fromEntries))

const placeMedia = Effect.fnUntraced(function* (parts: ReadonlyArray<DecisionPart>, imageInput: ImageInput) {
  const media = parts.flatMap((part) => (part.type === "media" ? [part.media] : []))
  if (media.length === 0) return { state: state(parts.map(plain)) }
  if (imageInput === "state") return { state: yield* Effect.forEach(parts, stateItem) }
  if (imageInput === "images") {
    const lists = { image: "images", audio: "audio", video: "videos" } as const
    const unplaced = media.find((asset) => !Object.hasOwn(lists, asset.kind))
    if (unplaced !== undefined) return yield* unsupported(unplaced, "images, audio and video")
    const inline = yield* Effect.forEach(media, (asset) => ProviderShared.requireInlineMedia(route.name, asset))
    const fields = Object.fromEntries(
      Object.entries(lists).flatMap(([kind, field]) => {
        const items = inline.filter((_, index) => media[index].kind === kind).map((item) => item.dataUrl)
        return items.length === 0 ? [] : [[field, items]]
      }),
    )
    return { state: state(parts.filter((part) => part.type !== "media").map(plain)), ...fields }
  }
  const unplaced = media.find((asset) => asset.kind !== "image")
  if (unplaced !== undefined) return yield* unsupported(unplaced, "images")
  const inline = yield* Effect.forEach(media, (asset) => ProviderShared.requireInlineMedia(route.name, asset))
  // Every occurrence of a reference string in the body is replaced with its image, so it must not be ordinary text.
  const reference = (index: number) => `<image-${index + 1}>`
  const items = parts.reduce<{ readonly next: number; readonly values: ReadonlyArray<unknown> }>(
    (acc, part) =>
      part.type === "media"
        ? { next: acc.next + 1, values: [...acc.values, reference(acc.next)] }
        : { next: acc.next, values: [...acc.values, plain(part)] },
    { next: 0, values: [] },
  ).values
  return {
    state: items,
    assets: Object.fromEntries(
      inline.map((item, index) => [
        reference(index),
        { type: "image", format: item.mime.slice("image/".length), data_base64: item.base64 },
      ]),
    ),
  }
})

/** A lone text or JSON part is the state itself; several are a list. */
const state = (items: ReadonlyArray<unknown>) => (items.length === 1 ? items[0] : items)

const plain = (part: DecisionPart) => {
  if (part.type === "text") return part.text
  if (part.type === "json") return part.value
  return undefined
}

const stateItem = (part: DecisionPart): Effect.Effect<unknown, AIError> => {
  if (part.type !== "media") return Effect.succeed(plain(part))
  const asset = part.media
  if (asset.kind !== "image" && asset.kind !== "audio" && asset.kind !== "video")
    return unsupported(asset, "images, audio and video")
  return ProviderShared.requireInlineMedia(route.name, asset).pipe(
    Effect.map((inline) => {
      if (asset.kind === "image") return { type: "image_url", image_url: { url: inline.dataUrl } }
      if (asset.kind === "video") return { type: "video_url", video_url: { url: inline.dataUrl } }
      return { type: "input_audio", input_audio: { data: inline.base64, format: inline.mime.slice("audio/".length) } }
    }),
  )
}

const unsupported = (asset: Media.Asset, accepted: string) =>
  Effect.fail(route.unsupported("decision.media", `${route.name} takes ${accepted} here; got ${asset.mediaType}`))

/** Map System One's answers, keyed by question name, back to the request's question order. */
export const toResponse = (
  data: Response,
  request: DecisionRequestFor,
  provider: ProviderID,
  invalid: (message: string) => AIError,
) => {
  const names = request.questions.map((question) => question.name)
  if (Object.keys(data.answers).length !== names.length || !names.every((name) => Object.hasOwn(data.answers, name)))
    return Effect.fail(invalid("System One answers do not match the requested questions"))
  return Effect.succeed(
    new DecisionResponse({
      answers: request.questions.map((question) => toAnswer(question, data.answers[question.name])),
      usage:
        data.usage === undefined
          ? undefined
          : new Usage({
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
              totalTokens: ProviderShared.totalTokens(data.usage.input_tokens, data.usage.output_tokens, undefined),
              providerMetadata: { [provider]: data.usage },
            }),
      providerMetadata: {
        [provider]: {
          model: data.model,
          ...(data.id === undefined ? {} : { responseId: data.id }),
          ...(data.provider === undefined ? {} : { provider: data.provider }),
          ...data.provider_metadata?.[provider],
        },
      },
    }),
  )
}

const toAnswer = (question: DecisionQuestion, answer: typeof Answer.Type): DecisionAnswer => {
  if (answer.type === "noul") return { name: question.name, type: "predicate", probability: answer.noul }
  if (answer.type === "choice") {
    const choices = question.type === "choice" ? question.choices : []
    const value = (key: string) => choices.find((choice) => String(choice.value) === key)?.value ?? key
    const rank = (key: string) => {
      const index = choices.findIndex((choice) => String(choice.value) === key)
      return index === -1 ? choices.length : index
    }
    return {
      name: question.name,
      type: "choice",
      choice: value(answer.choice),
      probabilities: Object.entries(answer.probabilities)
        .toSorted(([a], [b]) => rank(a) - rank(b))
        .map(([key, probability]) => ({ value: value(key), probability })),
      confidence: answer.confidence,
    }
  }
  const levels = question.type === "score" ? question.levels : []
  return {
    name: question.name,
    type: "score",
    score: answer.score,
    probabilities: Object.entries(answer.probabilities)
      .map(([key, probability]) => ({ value: Number(key), label: levels[Number(key)]?.label ?? key, probability }))
      .toSorted((a, b) => a.value - b.value),
    confidence: answer.confidence,
  }
}

export interface ModelInput extends MediaRoute.ModelInput {
  readonly provider: string
  /** Request path after `baseURL`; defaults to `/systemone`. */
  readonly path?: string
  /** Defaults to `assets`, models.dev's default. */
  readonly imageInput?: ImageInput
}

export const model = <Options extends DecisionOptions = DecisionOptions>(input: ModelInput) => {
  const provider = ProviderID.make(input.provider)
  const imageInput = input.imageInput ?? "assets"
  const identity = MediaProtocol.identity({ id: route.id, name: route.name, provider })
  const decode = identity.decodeJson(Response)
  const composed = MediaRoute.inline({
    protocol: MediaProtocol.inline<DecisionRequestFor<Options>, DecisionResponse>(identity, {
      body: {
        from: (request) =>
          encodeBody(request, imageInput).pipe(
            Effect.map((body) => MediaProtocol.json({ ...body, model: request.model.id })),
          ),
      },
      response: {
        decode: (response: HttpClientResponse.HttpClientResponse, context) =>
          decode(response).pipe(
            Effect.flatMap((output) => toResponse(output.value, context.request, provider, output.invalid)),
          ),
      },
    }),
    endpoint: Endpoint.path<MediaProtocol.Body, DecisionRequestFor<Options>>(input.path ?? DEFAULT_PATH, {
      baseURL: input.baseURL,
    }),
    auth: input.auth,
    headers: imageInput === "assets" ? { "TypeSafe-Danger-Zone-Images": "true", ...input.headers } : input.headers,
  })
  return DecisionModel.make<Options>({
    id: input.id,
    provider,
    http: input.http,
    route: { id: composed.id, inlineMedia: true, generate: composed.generate },
  })
}

export const SystemOne = { Response, encodeBody, toResponse, model } as const
