import { lazy, onCleanup, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { createKeyed, LinkHandler, onIdle, Panel, type PanelTab, type Setup } from "../sdk"
import type Sources from "./index"

/**
 * The Sources experiment's side panel: one transient tab per turn, keyed by the user message that opened it. The
 * timeline's sources chip opens it with a link whose origin is this extension and whose href is that message's ID.
 */
const setup: Setup<typeof Sources> = (ctx) => {
  const SourcesTab = lazy(() => import("./panel"))
  onCleanup(onIdle(() => void SourcesTab.preload()))

  // Tab objects per session, reused so strip updates and session switches do not rebuild a trigger.
  const tabs = new Map<string, Map<string, PanelTab>>()

  // Drops the tab objects of sessions whose shell tab closed.
  createKeyed(
    () => [...ctx.sessions.list().map((session) => session.key), ctx.sessions.current()?.key].join("\u0000"),
    () => {
      const keep = new Set([...ctx.sessions.list().map((session) => session.key), ctx.sessions.current()?.key])
      tabs.forEach((_cache, key) => {
        if (!keep.has(key)) tabs.delete(key)
      })
    },
  )

  ctx.add(LinkHandler, {
    match: (link) => link.origin === ctx.id && !!link.session,
    open(link) {
      if (link.session) ctx.layout.open(`${ctx.id}:${link.href}`, link.session, { tab: "select" })
    },
  })

  ctx.add(Panel, {
    id: "turn",
    region: "side",
    transient: true,
    list: (input) => {
      const cache = tabs.get(input.session.key) ?? new Map<string, PanelTab>()
      tabs.set(input.session.key, cache)

      return input.open.map((id) => {
        const existing = cache.get(id)

        if (existing) return existing

        const tab: PanelTab = {
          id,
          title: ctx.t("tab.title"),
          label: () => (
            <div class="flex min-w-0 items-center gap-1.5">
              <Icon name="globe" class="shrink-0" />
              <span class="truncate">{ctx.t("tab.title")}</span>
            </div>
          ),
        }

        cache.set(id, tab)

        return tab
      })
    },
    render: (props) => (
      <Suspense>
        <SourcesTab session={props.session} from={props.tab.id} />
      </Suspense>
    ),
    close: (input) => {
      tabs.get(input.session.key)?.delete(input.tab.id)
    },
  })
}

export default setup
