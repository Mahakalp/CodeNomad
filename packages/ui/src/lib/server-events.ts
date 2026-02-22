import { createSignal } from "solid-js"
import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getLogger } from "./logger"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
const log = getLogger("sse")

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    log.info(message, context)
    return
  }
  log.info(message)
}

const [retryCount, setRetryCount] = createSignal(0)
const [nextRetryDelay, setNextRetryDelay] = createSignal(0)
const [isReconnecting, setIsReconnecting] = createSignal(false)

class ServerEvents {
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: WorkspaceEventPayload) => void>>()
  private source: EventSource | null = null
  private retryDelay = RETRY_BASE_DELAY

  constructor() {
    this.connect()
  }

  getRetryCount() {
    return retryCount()
  }

  getNextRetryDelay() {
    return nextRetryDelay()
  }

  getIsReconnecting() {
    return isReconnecting()
  }

  reconnect() {
    this.retryDelay = RETRY_BASE_DELAY
    setRetryCount(0)
    setNextRetryDelay(0)
    setIsReconnecting(false)
    this.connect()
  }

  private connect() {
    if (this.source) {
      this.source.close()
    }
    setIsReconnecting(true)
    logSse("Connecting to backend events stream")
    this.source = serverApi.connectEvents((event) => this.dispatch(event), () => this.scheduleReconnect())
    this.source.onopen = () => {
      logSse("Events stream connected")
      this.retryDelay = RETRY_BASE_DELAY
      setRetryCount(0)
      setNextRetryDelay(0)
      setIsReconnecting(false)
    }
  }

  private scheduleReconnect() {
    if (this.source) {
      this.source.close()
      this.source = null
    }
    const currentRetry = retryCount() + 1
    setRetryCount(currentRetry)
    setNextRetryDelay(this.retryDelay)
    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay, retryCount: currentRetry })
    setTimeout(() => {
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      this.connect()
    }, this.retryDelay)
  }

  private dispatch(event: WorkspaceEventPayload) {
    logSse(`event ${event.type}`)
    this.handlers.get("*")?.forEach((handler) => handler(event))
    this.handlers.get(event.type)?.forEach((handler) => handler(event))
  }

  on(type: WorkspaceEventType | "*", handler: (event: WorkspaceEventPayload) => void): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    const bucket = this.handlers.get(type)!
    bucket.add(handler)
    return () => bucket.delete(handler)
  }
}

export const serverEvents = new ServerEvents()
