import type { Message, Part } from "@opencode-ai/sdk"
import { isRealUserMessage, isRealUserTextPart, log } from "../../shared"
import { AUTO_SLASH_COMMAND_TAG_OPEN } from "../../hooks/auto-slash-command/constants"
import { getMainSessionID, subagentSessions, syncSubagentSessions } from "../claude-code-session-state"
import type { TranslationConfig, TranslationConfigInput } from "./types"
import { DEFAULT_TRANSLATION_CONFIG } from "./types"
import { translateMessage, shouldSkipTranslation } from "./translator"
import { isSupportedCloudProvider, resolveGoogleApiKey } from "./cloud-client"
import { ensureOllamaRunning, isOllamaInstalled, installOllama } from "./ollama-installer"
import { ensureModelPulled } from "./model-puller"
import { checkOllamaHealth } from "./ollama-client"

function resolveConfig(rawConfig: TranslationConfigInput | undefined): TranslationConfig {
  const resolved: Record<string, unknown> = {
    ...DEFAULT_TRANSLATION_CONFIG,
    cloud: { ...DEFAULT_TRANSLATION_CONFIG.cloud },
  }
  if (rawConfig) {
    for (const [key, value] of Object.entries(rawConfig)) {
      if (value === undefined) continue
      if (key === "cloud" && typeof value === "object" && value !== null) {
        resolved[key] = { ...DEFAULT_TRANSLATION_CONFIG.cloud, ...value }
      } else {
        resolved[key] = value
      }
    }
  }
  return resolved as unknown as TranslationConfig
}

interface MessageWithParts {
  info: Message
  parts: Part[]
}

export interface LocalTranslatorToastBody {
  readonly title?: string
  readonly message: string
  readonly variant: "info" | "success" | "warning" | "error"
  readonly duration?: number
}

export interface LocalTranslatorDependencies {
  readonly client?: {
    readonly tui?: {
      readonly showToast?: (options: { readonly body: LocalTranslatorToastBody }) => Promise<unknown>
    }
    readonly session?: {
      readonly get?: (options: { readonly path: { readonly id: string } }) => Promise<{
        data?: {
          parentID?: string
        }
      }>
    }
  }
}

async function showToastSafely(
  deps: LocalTranslatorDependencies | undefined,
  body: LocalTranslatorToastBody,
): Promise<void> {
  try {
    await deps?.client?.tui?.showToast?.({ body })
  } catch (error) {
    log("[local-translator] Failed to show toast", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function shouldSkipForSession(
  sessionID: string | undefined,
  deps: LocalTranslatorDependencies | undefined,
): Promise<boolean> {
  if (!sessionID) return false
  if (subagentSessions.has(sessionID) || syncSubagentSessions.has(sessionID)) {
    log("[local-translator] Skipping translation for subagent session", { sessionID })
    return true
  }
  const mainSessionID = getMainSessionID()
  if (mainSessionID && sessionID !== mainSessionID) {
    log("[local-translator] Skipping translation for non-main session", { sessionID, mainSessionID })
    return true
  }
  if (deps?.client?.session?.get) {
    try {
      const sessionResult = await deps.client.session.get({ path: { id: sessionID } })
      if (sessionResult?.data?.parentID) {
        log("[local-translator] Skipping translation for child session with parentID", {
          sessionID,
          parentID: sessionResult.data.parentID,
        })
        return true
      }
    } catch (error) {
      log("[local-translator] Failed to query session info for parentID", {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return false
}

export function createLocalTranslatorHook(
  rawConfig: TranslationConfigInput | undefined,
  deps?: LocalTranslatorDependencies,
) {
  const config = resolveConfig(rawConfig)

  let initializationPromise: Promise<boolean> | null = null

  async function ensureCloudReady(): Promise<boolean> {
    if (!isSupportedCloudProvider(config.cloud.provider)) {
      log(
        `[local-translator] Unsupported cloud provider "${config.cloud.provider}", passing through original text`,
      )
      return false
    }
    if (!resolveGoogleApiKey()) {
      log("[local-translator] No Google API key found (env or opencode auth.json)")
      return false
    }
    return true
  }

  async function ensureOllamaReady(): Promise<boolean> {
    if (initializationPromise) return initializationPromise

    initializationPromise = (async () => {
      if (await checkOllamaHealth(config.ollamaHost)) {
        return await ensureModelPulled(config.ollamaHost, config.model)
      }

      if (!isOllamaInstalled()) {
        if (!config.autoInstall) {
          log("[local-translator] Ollama not installed and auto_install is false")
          return false
        }
        const installed = await installOllama()
        if (!installed) return false
      }

      const running = await ensureOllamaRunning(config.ollamaHost)
      if (!running) return false

      await ensureModelPulled(config.ollamaHost, config.model)
      return true
    })()

    return initializationPromise
  }

  async function ensureTranslatorReady(): Promise<boolean> {
    if (config.mode === "cloud") return ensureCloudReady()
    return ensureOllamaReady()
  }

  return {
    "experimental.chat.messages.transform": async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      if (!config.enabled) return

      const { messages } = output
      if (messages.length === 0) return

      let lastUserMessageIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.info.role === "user") {
          lastUserMessageIndex = i
          break
        }
      }
      if (lastUserMessageIndex === -1) return

      const lastUserMessage = messages[lastUserMessageIndex]
      if (!lastUserMessage || !isRealUserMessage(lastUserMessage)) return

      const sessionID = lastUserMessage.info.sessionID
      if (await shouldSkipForSession(sessionID, deps)) return

      const textPartIndex = lastUserMessage.parts.findIndex(
        (part) =>
          isRealUserTextPart(part) &&
          "text" in part &&
          typeof part.text === "string" &&
          part.text.length > 0 &&
          !part.text.includes(AUTO_SLASH_COMMAND_TAG_OPEN),
      )
      if (textPartIndex === -1) return

      const textPart = lastUserMessage.parts[textPartIndex]
      const originalText = (textPart as { text: string }).text
      if (!originalText) return

      if (shouldSkipTranslation(originalText, config.minLength).skip) return

      if (config.showNotifications) {
        const backendModel = config.mode === "cloud" ? config.cloud.model : config.model
        void showToastSafely(deps, {
          title: "momo translator",
          message: `Translating & compacting prompt via ${backendModel}...`,
          variant: "info",
          duration: 3000,
        })
      }

      const ready = await ensureTranslatorReady()
      if (!ready) {
        log("[local-translator] Translator not ready, passing through original text")
        if (config.showNotifications) {
          void showToastSafely(deps, {
            title: "momo translator",
            message: "Translator not ready, passing original prompt through",
            variant: "warning",
            duration: 4000,
          })
        }
        return
      }

      const result = await translateMessage(config, originalText)

      if (result.skipped) {
        log("[local-translator] Skipped translation", { reason: result.skipReason })
        if (config.showNotifications && result.skipReason) {
          const isError = result.skipReason.startsWith("error:")
          void showToastSafely(deps, {
            title: isError ? "momo translator failed" : "momo translator",
            message: isError
              ? `Passing through original prompt (${result.skipReason.replace(/^error:\s*/, "")})`
              : `Skipped (${result.skipReason})`,
            variant: isError ? "warning" : "info",
            duration: isError ? 5000 : 3000,
          })
        }
        return
      }

      ;(lastUserMessage.parts[textPartIndex] as { text: string }).text = result.translatedText

      log("[local-translator] Translated user message", {
        latencyMs: result.latencyMs,
        originalLength: originalText.length,
        translatedLength: result.translatedText.length,
      })

      if (config.showNotifications) {
        const origLen = originalText.length
        const transLen = result.translatedText.length
        const pct = Math.round(((origLen - transLen) / origLen) * 100)
        const stats = pct > 0
          ? `Compacted: ${origLen} -> ${transLen} chars (-${pct}%)`
          : `Translated: ${origLen} -> ${transLen} chars`
        const preview = result.translatedText.length > 200
          ? `${result.translatedText.slice(0, 197)}...`
          : result.translatedText

        void showToastSafely(deps, {
          title: `momo translator (${(result.latencyMs / 1000).toFixed(1)}s)`,
          message: `${stats}\n-> "${preview}"`,
          variant: "success",
          duration: 7000,
        })
      }
    },
  }
}
