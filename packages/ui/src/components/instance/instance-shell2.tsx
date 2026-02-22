import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js"
import AppBar from "@suid/material/AppBar"
import Box from "@suid/material/Box"
import IconButton from "@suid/material/IconButton"
import Toolbar from "@suid/material/Toolbar"
import useMediaQuery from "@suid/material/useMediaQuery"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import type { BackgroundProcess } from "../../../../server/src/api-types"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"

import { isOpen as isCommandPaletteOpen, hideCommandPalette, showCommandPalette } from "../../stores/command-palette"
import Kbd from "../kbd"
import InstanceWelcomeView from "../instance-welcome-view"
import CommandPalette from "../command-palette"
import PermissionNotificationBanner from "../permission-notification-banner"
import PermissionApprovalModal from "../permission-approval-modal"
import { formatTokenTotal } from "../../lib/formatters"
import ContextMeter from "../context-meter"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import { serverApi } from "../../lib/api-client"
import { loadBackgroundProcesses } from "../../stores/background-processes"
import { BackgroundProcessOutputDialog } from "../background-process-output-dialog"
import { useI18n } from "../../lib/i18n"
import { getPermissionQueueLength, getQuestionQueueLength } from "../../stores/instances"
import { useSessionSidebarRequests } from "./shell/useSessionSidebarRequests"
import { useDrawerChrome } from "./shell/useDrawerChrome"
import { getSessionStatus } from "../../stores/session-status"
import { Maximize2, ShieldAlert } from "lucide-solid"

import type { LayoutMode } from "./shell/types"
import {
  DEFAULT_SESSION_SIDEBAR_WIDTH,
  LEFT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_WIDTH,
  clampRightWidth,
  clampWidth,
} from "./shell/storage"
import { useDrawerHostMeasure } from "./shell/useDrawerHostMeasure"
import { useDrawerResize } from "./shell/useDrawerResize"
import { useSessionCache } from "./shell/useSessionCache"
import { useInstanceSessionContext } from "./shell/useInstanceSessionContext"
import { SessionListPanel } from "./session-list-panel"
import { StatusPanel } from "./status-panel"
import { MessagePanel } from "./message-panel"
import ErrorBoundary from "../ui/error-boundary"

const log = getLogger("session")

interface InstanceShellProps {
  instance: Instance
  escapeInDebounce: boolean
  paletteCommands: Accessor<Command[]>
  onCloseSession: (sessionId: string) => Promise<void> | void
  onNewSession: () => Promise<void> | void
  handleSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  handleSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onExecuteCommand: (command: Command) => void
  tabBarOffset: number

  mobileFullscreenMode: boolean
  onEnterMobileFullscreen: () => void
  onExitMobileFullscreen: () => void
}

const InstanceShell2: Component<InstanceShellProps> = (props) => {
  const { t } = useI18n()

  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)
  const [rightDrawerWidth, setRightDrawerWidth] = createSignal(
    typeof window !== "undefined" ? clampRightWidth(window.innerWidth * 0.35) : RIGHT_DRAWER_WIDTH,
  )
  const [rightDrawerWidthInitialized, setRightDrawerWidthInitialized] = createSignal(false)
  const [leftDrawerContentEl, setLeftDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [rightDrawerContentEl, setRightDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [leftToggleButtonEl, setLeftToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [rightToggleButtonEl, setRightToggleButtonEl] = createSignal<HTMLElement | null>(null)

  const [selectedBackgroundProcess, setSelectedBackgroundProcess] = createSignal<BackgroundProcess | null>(null)
  const [showBackgroundOutput, setShowBackgroundOutput] = createSignal(false)
  const [permissionModalOpen, setPermissionModalOpen] = createSignal(false)

  const [showSessionSearch, setShowSessionSearch] = createSignal(false)

  const {
    allInstanceSessions,
    sessionThreads,
    activeSessions,
    activeSessionIdForInstance,
    activeSessionForInstance,
    activeSessionDiffs,
    latestTodoState,
    tokenStats,
    backgroundProcessList,
    handleSessionSelect,
  } = useInstanceSessionContext({
    instanceId: () => props.instance.id,
  })

  const desktopQuery = useMediaQuery("(min-width: 1280px)")
  const tabletQuery = useMediaQuery("(min-width: 768px)")

  const layoutMode = createMemo<LayoutMode>(() => {
    if (desktopQuery()) return "desktop"
    if (tabletQuery()) return "tablet"
    return "phone"
  })

  const isPhoneLayout = createMemo(() => layoutMode() === "phone")
  const mobileFullscreen = createMemo(() => props.mobileFullscreenMode && isPhoneLayout())
  const compactPromptLayout = createMemo(() => layoutMode() !== "desktop")
  const leftPinningSupported = createMemo(() => layoutMode() !== "phone")
  const rightPinningSupported = createMemo(() => layoutMode() !== "phone")

  const { setDrawerHost, drawerContainer, measureDrawerHost, floatingTopPx, floatingHeight } = useDrawerHostMeasure(
    () => props.tabBarOffset,
  )

  const drawerChrome = useDrawerChrome({
    t,
    layoutMode,
    leftPinningSupported,
    rightPinningSupported,
    leftDrawerContentEl,
    rightDrawerContentEl,
    leftToggleButtonEl,
    rightToggleButtonEl,
    measureDrawerHost,
  })

  const {
    leftPinned,
    leftOpen,
    rightPinned,
    rightOpen,
    setLeftOpen,
    setRightOpen,
    leftDrawerState,
    rightDrawerState,
    pinLeft: pinLeftDrawer,
    unpinLeft: unpinLeftDrawer,
    pinRight: pinRightDrawer,
    unpinRight: unpinRightDrawer,
    closeLeft: closeLeftDrawer,
    closeRight: closeRightDrawer,
    leftAppBarButtonLabel,
    rightAppBarButtonLabel,
    leftAppBarButtonIcon,
    rightAppBarButtonIcon,
    handleLeftAppBarButtonClick,
    handleRightAppBarButtonClick,
  } = drawerChrome

  createEffect(() => {
    const instanceId = props.instance.id
    loadBackgroundProcesses(instanceId).catch((error) => {
      log.warn("Failed to load background processes", error)
    })
  })

  onMount(() => {
    if (typeof window === "undefined") return

    const savedLeft = window.localStorage.getItem(LEFT_DRAWER_STORAGE_KEY)
    if (savedLeft) {
      const parsed = Number.parseInt(savedLeft, 10)
      if (Number.isFinite(parsed)) {
        setSessionSidebarWidth(clampWidth(parsed))
      }
    }

    let didLoadRightWidth = false
    const savedRight = window.localStorage.getItem(RIGHT_DRAWER_STORAGE_KEY)
    if (savedRight) {
      const parsed = Number.parseInt(savedRight, 10)
      if (Number.isFinite(parsed)) {
        setRightDrawerWidth(clampRightWidth(parsed))
        didLoadRightWidth = true
      }
    }

    if (!didLoadRightWidth) {
      setRightDrawerWidth(clampRightWidth(window.innerWidth * 0.35))
    }

    setRightDrawerWidthInitialized(true)

    const handleResize = () => {
      const width = clampWidth(window.innerWidth * 0.3)
      setSessionSidebarWidth((current) => clampWidth(current || width))
      const fallbackRight = window.innerWidth * 0.35
      setRightDrawerWidth((current) => clampRightWidth(current || fallbackRight))
      measureDrawerHost()
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(LEFT_DRAWER_STORAGE_KEY, sessionSidebarWidth().toString())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_DRAWER_STORAGE_KEY, rightDrawerWidth().toString())
  })

  const connectionStatus = () => sseManager.getStatus(props.instance.id)
  const connectionStatusClass = () => {
    const status = connectionStatus()
    if (status === "connecting") return "connecting"
    if (status === "connected") return "connected"
    return "disconnected"
  }

  const connectionStatusLabel = () => {
    const status = connectionStatus()
    if (status === "connected") return t("instanceShell.connection.connected")
    if (status === "connecting") return t("instanceShell.connection.connecting")
    if (status === "error" || status === "disconnected") return t("instanceShell.connection.disconnected")
    return t("instanceShell.connection.unknown")
  }

  const [retryCount, setRetryCount] = createSignal(0)
  const [nextRetryDelay, setNextRetryDelay] = createSignal(0)
  const [isReconnecting, setIsReconnecting] = createSignal(false)
  const [retryCountdown, setRetryCountdown] = createSignal(0)

  const updateRetryState = () => {
    const count = sseManager.getRetryCount()
    const delay = sseManager.getNextRetryDelay()
    const reconnecting = sseManager.getIsReconnecting()
    setRetryCount(count)
    setNextRetryDelay(delay)
    setIsReconnecting(reconnecting)
    if (delay > 0 && reconnecting) {
      setRetryCountdown(Math.ceil(delay / 1000))
    }
  }

  createEffect(() => {
    updateRetryState()
    const interval = setInterval(() => {
      const delay = nextRetryDelay()
      if (delay > 0) {
        setRetryCountdown((prev) => Math.max(0, prev - 1))
      }
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const handleRetry = () => {
    sseManager.reconnect()
    setRetryCountdown(0)
    updateRetryState()
  }

  const hasPendingRequests = createMemo(() => {
    const permissions = getPermissionQueueLength(props.instance.id)
    const questions = getQuestionQueueLength(props.instance.id)
    return permissions + questions > 0
  })

  const activeSessionStatusPill = createMemo(() => {
    const activeSessionId = activeSessionIdForInstance()
    if (!activeSessionId || activeSessionId === "info") return null

    const activeSession = activeSessionForInstance()
    const needsPermission = Boolean(activeSession?.pendingPermission)
    const needsQuestion = Boolean(activeSession?.pendingQuestion)
    const needsInput = needsPermission || needsQuestion

    if (needsInput) {
      return {
        className: "session-permission",
        text: needsPermission
          ? t("sessionList.status.needsPermission")
          : t("sessionList.status.needsInput"),
        showAlertIcon: true,
      }
    }

    const status = getSessionStatus(props.instance.id, activeSessionId)
    const text =
      status === "working"
        ? t("sessionList.status.working")
        : status === "compacting"
          ? t("sessionList.status.compacting")
          : t("sessionList.status.idle")

    return {
      className: `session-${status}`,
      text,
      showAlertIcon: false,
    }
  })

  const renderActiveSessionStatusPill = () => {
    const pill = activeSessionStatusPill()
    if (!pill) return null
    return (
      <span class={`status-indicator session-status session-status-list ${pill.className}`}>
        {pill.showAlertIcon ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
        {pill.text}
      </span>
    )
  }

  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instance.id)
  }

  const openBackgroundOutput = (process: BackgroundProcess) => {
    setSelectedBackgroundProcess(process)
    setShowBackgroundOutput(true)
  }

  const closeBackgroundOutput = () => {
    setShowBackgroundOutput(false)
    setSelectedBackgroundProcess(null)
  }

  const stopBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.stopBackgroundProcess(props.instance.id, processId)
    } catch (error) {
      log.warn("Failed to stop background process", error)
    }
  }

  const terminateBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.terminateBackgroundProcess(props.instance.id, processId)
    } catch (error) {
      log.warn("Failed to terminate background process", error)
    }
  }

  const instancePaletteCommands = createMemo(() => props.paletteCommands())
  const paletteOpen = createMemo(() => isCommandPaletteOpen(props.instance.id))

  const keyboardShortcuts = createMemo(() =>
    [keyboardRegistry.get("session-prev"), keyboardRegistry.get("session-next")].filter(
      (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut),
    ),
  )

  useSessionSidebarRequests({
    instanceId: () => props.instance.id,
    sidebarContentEl: leftDrawerContentEl,
    leftPinned,
    leftOpen,
    setLeftOpen,
    measureDrawerHost,
  })

  const { cachedSessionIds } = useSessionCache({
    instanceId: () => props.instance.id,
    instanceSessions: allInstanceSessions,
    activeSessionId: activeSessionIdForInstance,
  })

  const showEmbeddedSidebarToggle = createMemo(() => !leftPinned() && !leftOpen())

  const { handleDrawerResizeMouseDown, handleDrawerResizeTouchStart } = useDrawerResize({
    sessionSidebarWidth,
    rightDrawerWidth,
    setSessionSidebarWidth,
    setRightDrawerWidth,
    clampLeft: clampWidth,
    clampRight: clampRightWidth,
    measureDrawerHost,
  })

  const hasSessions = createMemo(() => activeSessions().size > 0)
  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")

  const sessionLayout = (
    <div
      class="session-shell-panels flex flex-1 min-h-0 overflow-x-hidden"
      ref={(element) => {
        setDrawerHost(element)
        measureDrawerHost()
      }}
    >
      <ErrorBoundary onError={(error) => log.error("SessionListPanel error", error)}>
        <SessionListPanel
        t={t}
        instanceId={props.instance.id}
        sessionSidebarWidth={sessionSidebarWidth}
        sessionThreads={sessionThreads}
        activeSessionId={activeSessionIdForInstance}
        activeSession={activeSessionForInstance}
        showSearch={showSessionSearch}
        onToggleSearch={() => setShowSessionSearch((current) => !current)}
        keyboardShortcuts={keyboardShortcuts}
        isPhoneLayout={isPhoneLayout}
        drawerState={leftDrawerState}
        leftPinned={leftPinned}
        leftOpen={leftOpen}
        onSelectSession={handleSessionSelect}
        onNewSession={props.onNewSession}
        onSidebarAgentChange={props.handleSidebarAgentChange}
        onSidebarModelChange={props.handleSidebarModelChange}
        onPinLeftDrawer={pinLeftDrawer}
        onUnpinLeftDrawer={unpinLeftDrawer}
        onCloseLeftDrawer={closeLeftDrawer}
        setLeftDrawerContentEl={setLeftDrawerContentEl}
        leftDrawerState={leftDrawerState}
        floatingTopPx={floatingTopPx}
        floatingHeight={floatingHeight}
        drawerContainer={drawerContainer}
        handleDrawerResizeMouseDown={handleDrawerResizeMouseDown}
        handleDrawerResizeTouchStart={handleDrawerResizeTouchStart}
      />
      </ErrorBoundary>

      <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden" }}>
        <Show when={!mobileFullscreen()}>
          <AppBar position="sticky" color="default" elevation={0} class="border-b border-base">
            <Toolbar variant="dense" class="session-toolbar flex flex-wrap items-center gap-2 py-0 min-h-[40px]">
              <Show
                when={!isPhoneLayout()}
                fallback={
                  <div class="flex flex-col w-full gap-1.5">
                    <div class="flex flex-wrap items-center justify-between gap-2 w-full">
                    <Show when={leftDrawerState() === "floating-closed"}>
                      <IconButton
                        ref={setLeftToggleButtonEl}
                        color="inherit"
                        onClick={handleLeftAppBarButtonClick}
                        aria-label={leftAppBarButtonLabel()}
                        size="small"
                        aria-expanded={leftDrawerState() !== "floating-closed"}
                      >
                       {leftAppBarButtonIcon()}
                      </IconButton>
                    </Show>

                    <div class="flex-1 flex items-center justify-center min-w-0">
                      <Show when={hasPendingRequests()} fallback={renderActiveSessionStatusPill()}>
                        <PermissionNotificationBanner
                          instanceId={props.instance.id}
                          onClick={() => setPermissionModalOpen(true)}
                        />
                      </Show>
                    </div>

                    <div class="flex flex-wrap items-center justify-center gap-1">
                      <button
                        type="button"
                        class="connection-status-button command-palette-button"
                        onClick={handleCommandPaletteClick}
                        aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                        style={{ flex: "0 0 auto", width: "auto" }}
                      >
                        {t("instanceShell.commandPalette.button")}
                      </button>
                      <span class="connection-status-shortcut-hint kbd-hint">
                        <Kbd shortcut="cmd+shift+p" />
                      </span>
                    </div>

                    <div class="flex-1 flex items-center justify-center min-w-0">
                      <span
                        class={`status-indicator ${connectionStatusClass()}`}
                        aria-label={t("instanceShell.connection.ariaLabel", { status: connectionStatusLabel() })}
                      >
                        <span class="status-dot" />
                      </span>
                    </div>

                    <Show when={!props.mobileFullscreenMode}>
                      <IconButton
                        color="inherit"
                        onClick={props.onEnterMobileFullscreen}
                        aria-label={t("instanceShell.fullscreen.enter")}
                        title={t("instanceShell.fullscreen.enter")}
                        size="small"
                      >
                        <Maximize2 class="w-5 h-5" aria-hidden="true" />
                      </IconButton>
                    </Show>

                    <Show when={rightDrawerState() === "floating-closed"}>
                      <IconButton
                        ref={setRightToggleButtonEl}
                        color="inherit"
                        onClick={handleRightAppBarButtonClick}
                        aria-label={rightAppBarButtonLabel()}
                        size="small"
                        aria-expanded={rightDrawerState() !== "floating-closed"}
                      >
                        {rightAppBarButtonIcon()}
                      </IconButton>
                    </Show>
                  </div>

                    <div class="flex flex-wrap items-center justify-center gap-2 pb-1">
                      <ContextMeter
                        usedTokens={tokenStats().used}
                        availableTokens={tokenStats().avail}
                        formatTokens={formatTokenTotal}
                        usedLabel={t("instanceShell.metrics.usedLabel")}
                        availableLabel={t("instanceShell.metrics.availableLabel")}
                      />
                    </div>
                </div>
              }
            >
              <div class="session-toolbar-left flex-1 flex items-center gap-3 min-w-0">
                <Show when={leftDrawerState() === "floating-closed"}>
                  <IconButton
                    ref={setLeftToggleButtonEl}
                    color="inherit"
                    onClick={handleLeftAppBarButtonClick}
                    aria-label={leftAppBarButtonLabel()}
                    size="small"
                    aria-expanded={leftDrawerState() !== "floating-closed"}
                  >
                    {leftAppBarButtonIcon()}
                  </IconButton>
                </Show>

                <Show when={!showingInfoView()}>
                  <ContextMeter
                    usedTokens={tokenStats().used}
                    availableTokens={tokenStats().avail}
                    formatTokens={formatTokenTotal}
                    usedLabel={t("instanceShell.metrics.usedLabel")}
                    availableLabel={t("instanceShell.metrics.availableLabel")}
                  />
                </Show>

                <div class="ml-auto flex items-center session-header-hints">
                  <Show when={hasPendingRequests()} fallback={renderActiveSessionStatusPill()}>
                    <PermissionNotificationBanner
                      instanceId={props.instance.id}
                      onClick={() => setPermissionModalOpen(true)}
                    />
                  </Show>
                </div>
              </div>

              <div class="session-toolbar-center flex items-center justify-center gap-2 min-w-[160px]">
                <button
                  type="button"
                  class="connection-status-button command-palette-button"
                  onClick={handleCommandPaletteClick}
                  aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                  style={{ flex: "0 0 auto", width: "auto" }}
                >
                  {t("instanceShell.commandPalette.button")}
                </button>
              </div>

              <div class="session-toolbar-right flex-1 flex items-center gap-3">
                <span class="connection-status-shortcut-hint kbd-hint">
                  <Kbd shortcut="cmd+shift+p" />
                </span>

                <div class="ml-auto flex items-center gap-3">
                  <div class="connection-status-meta flex items-center gap-3">
                    <Show when={connectionStatus() === "connected"}>
                      <span class="status-indicator connected">
                        <span class="status-dot" />
                        <span class="status-text">{t("instanceShell.connection.connected")}</span>
                      </span>
                    </Show>
                    <Show when={connectionStatus() === "connecting"}>
                      <span class="status-indicator connecting">
                        <span class="status-dot" />
                        <span class="status-text">{t("instanceShell.connection.connecting")}</span>
                      </span>
                    </Show>
                    <Show when={connectionStatus() === "error" || connectionStatus() === "disconnected"}>
                      <span class="status-indicator disconnected">
                        <span class="status-dot" />
                        <span class="status-text">
                          <Show when={isReconnecting() && retryCount() > 0} fallback={t("instanceShell.connection.disconnected")}>
                            {t("instanceShell.connection.reconnecting", { count: retryCount().toString() })}
                          </Show>
                        </span>
                        <Show when={isReconnecting() && retryCountdown() > 0}>
                          <span class="status-text retry-countdown">
                            {t("instanceShell.connection.retryHint", { seconds: retryCountdown().toString() })}
                          </span>
                        </Show>
                        <button
                          type="button"
                          class="retry-button"
                          onClick={handleRetry}
                          aria-label={t("instanceShell.connection.retry")}
                        >
                          {t("instanceShell.connection.retry")}
                        </button>
                      </span>
                    </Show>
                  </div>
                  <Show when={rightDrawerState() === "floating-closed"}>
                    <IconButton
                      ref={setRightToggleButtonEl}
                      color="inherit"
                      onClick={handleRightAppBarButtonClick}
                      aria-label={rightAppBarButtonLabel()}
                      size="small"
                      aria-expanded={rightDrawerState() !== "floating-closed"}
                    >
                      {rightAppBarButtonIcon()}
                    </IconButton>
                  </Show>
                </div>
              </div>
              </Show>
            </Toolbar>
          </AppBar>
        </Show>

        <ErrorBoundary onError={(error) => log.error("MessagePanel error", error)}>
          <MessagePanel
            t={t}
            instanceId={props.instance.id}
            instanceFolder={props.instance.folder}
            escapeInDebounce={props.escapeInDebounce}
            activeSessionIdForInstance={activeSessionIdForInstance}
            activeSessions={activeSessions}
            cachedSessionIds={cachedSessionIds}
            isPhoneLayout={isPhoneLayout}
            compactPromptLayout={compactPromptLayout}
            showEmbeddedSidebarToggle={showEmbeddedSidebarToggle}
            mobileFullscreen={mobileFullscreen}
            showingInfoView={showingInfoView}
            hasPendingRequests={hasPendingRequests}
            tokenStats={tokenStats}
            connectionStatus={connectionStatus}
            connectionStatusClass={connectionStatusClass}
            connectionStatusLabel={connectionStatusLabel}
            onSidebarToggle={() => setLeftOpen(true)}
            onPermissionBannerClick={() => setPermissionModalOpen(true)}
            setPermissionModalOpen={setPermissionModalOpen}
            renderActiveSessionStatusPill={renderActiveSessionStatusPill}
          />
        </ErrorBoundary>
      </Box>

      <ErrorBoundary onError={(error) => log.error("StatusPanel error", error)}>
        <StatusPanel
        t={t}
        instanceId={props.instance.id}
        instance={props.instance}
        rightDrawerWidth={rightDrawerWidth}
        rightDrawerWidthInitialized={rightDrawerWidthInitialized}
        activeSessionId={activeSessionIdForInstance}
        activeSession={activeSessionForInstance}
        activeSessionDiffs={activeSessionDiffs}
        latestTodoState={latestTodoState}
        backgroundProcessList={backgroundProcessList}
        onOpenBackgroundOutput={openBackgroundOutput}
        onStopBackgroundProcess={stopBackgroundProcess}
        onTerminateBackgroundProcess={terminateBackgroundProcess}
        isPhoneLayout={isPhoneLayout}
        rightDrawerState={rightDrawerState}
        rightPinned={rightPinned}
        rightOpen={rightOpen}
        onCloseRightDrawer={closeRightDrawer}
        onPinRightDrawer={pinRightDrawer}
        onUnpinRightDrawer={unpinRightDrawer}
        setRightDrawerContentEl={setRightDrawerContentEl}
        floatingTopPx={floatingTopPx}
        floatingHeight={floatingHeight}
        drawerContainer={drawerContainer}
        handleDrawerResizeMouseDown={handleDrawerResizeMouseDown}
        handleDrawerResizeTouchStart={handleDrawerResizeTouchStart}
      />
      </ErrorBoundary>
    </div>
  )

  return (
    <>
      <div class="instance-shell2 flex flex-col flex-1 min-h-0">
        <Show when={hasSessions()} fallback={<InstanceWelcomeView instance={props.instance} />}>
          {sessionLayout}
        </Show>
      </div>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => hideCommandPalette(props.instance.id)}
        commands={instancePaletteCommands()}
        onExecute={props.onExecuteCommand}
      />

      <BackgroundProcessOutputDialog
        open={showBackgroundOutput()}
        instanceId={props.instance.id}
        process={selectedBackgroundProcess()}
        onClose={closeBackgroundOutput}
      />

      <PermissionApprovalModal
        instanceId={props.instance.id}
        isOpen={permissionModalOpen()}
        onClose={() => setPermissionModalOpen(false)}
      />
    </>
  )
}

export default InstanceShell2
