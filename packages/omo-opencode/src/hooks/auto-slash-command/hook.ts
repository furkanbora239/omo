import { isRecord } from "@oh-my-opencode/utils"
import {
  detectSlashCommand,
  extractPromptText,
  findSlashCommandPartIndex,
  findSlashCommandTokens,
} from "./detector"
import { executeSlashCommand, listCommandNames, type ExecutorOptions } from "./executor"
import { log } from "../../shared"
import { resolveSessionEventID } from "../../shared/event-session-id"
import {
  AUTO_SLASH_COMMAND_TAG_CLOSE,
  AUTO_SLASH_COMMAND_TAG_OPEN,
} from "./constants"
import { createProcessedCommandStore } from "./processed-command-store"
import type {
  AutoSlashCommandHookInput,
  AutoSlashCommandHookOutput,
  CommandExecuteBeforeInput,
  CommandExecuteBeforeOutput,
  SlashCommandToken,
} from "./types"
import type { LoadedSkill } from "../../features/opencode-skill-loader"

const COMMAND_EXECUTE_FALLBACK_DEDUP_TTL_MS = 100



function getDeletedSessionID(properties: unknown): string | null {
  return resolveSessionEventID(properties) ?? null
}

function getCommandExecutionEventID(input: CommandExecuteBeforeInput): string | null {
  const candidateKeys = [
    "messageID",
    "messageId",
    "eventID",
    "eventId",
    "invocationID",
    "invocationId",
    "commandID",
    "commandId",
  ]

  const recordInput: unknown = input
  if (!isRecord(recordInput)) {
    return null
  }

  for (const key of candidateKeys) {
    const candidateValue = recordInput[key]
    if (typeof candidateValue === "string" && candidateValue.length > 0) {
      return candidateValue
    }
  }

  return null
}

function partsContainAutoSlashCommandTags(parts: Array<{ text?: string }>): boolean {
  return parts.some((part) =>
    typeof part.text === "string"
    && (
      part.text.includes(AUTO_SLASH_COMMAND_TAG_OPEN)
      || part.text.includes(AUTO_SLASH_COMMAND_TAG_CLOSE)
    )
  )
}

function findCommandPartIndex(
  parts: Array<{ type: string; text?: string }>,
  promptText: string,
  token: SlashCommandToken,
): number {
  const slashPartIndex = findSlashCommandPartIndex(parts)
  if (slashPartIndex >= 0) {
    return slashPartIndex
  }
  const commandText = promptText.slice(token.tokenStart, token.tokenEnd)
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (typeof part.text === "string" && part.text.includes(commandText)) {
      return i
    }
  }
  return -1
}

export interface AutoSlashCommandHookOptions {
  skills?: LoadedSkill[]
  pluginsEnabled?: boolean
  enabledPluginsOverride?: Record<string, boolean>
  directory?: string
}

export function createAutoSlashCommandHook(options?: AutoSlashCommandHookOptions) {
  const executorOptions: ExecutorOptions = {
    skills: options?.skills,
    pluginsEnabled: options?.pluginsEnabled,
    enabledPluginsOverride: options?.enabledPluginsOverride,
    directory: options?.directory,
  }
  const sessionProcessedCommands = createProcessedCommandStore()
  const sessionProcessedCommandExecutions = createProcessedCommandStore()
  let knownCommandNames: Set<string> | null = null

  const getKnownCommandNames = async (): Promise<Set<string>> => {
    if (knownCommandNames === null) {
      const names = await listCommandNames(executorOptions)
      knownCommandNames = new Set(names)
    }
    return knownCommandNames
  }

  const dispose = (): void => {
    sessionProcessedCommands.clear()
    sessionProcessedCommandExecutions.clear()
    knownCommandNames = null
  }

  return {
    "chat.message": async (
      input: AutoSlashCommandHookInput,
      output: AutoSlashCommandHookOutput
    ): Promise<void> => {
      const promptText = extractPromptText(output.parts)

      // Debug logging to diagnose slash command issues
      if (promptText.startsWith("/")) {
        log(`[auto-slash-command] chat.message hook received slash command`, {
          sessionID: input.sessionID,
          promptText: promptText.slice(0, 100),
        })
      }

      if (
        promptText.includes(AUTO_SLASH_COMMAND_TAG_OPEN) ||
        promptText.includes(AUTO_SLASH_COMMAND_TAG_CLOSE)
      ) {
        return
      }

      const executionOptions: ExecutorOptions = {
        ...executorOptions,
        agent: input.agent,
        sessionID: input.sessionID,
      }

      const tokens = findSlashCommandTokens(promptText)
      const knownCommandNames = await getKnownCommandNames()
      const knownTokens: SlashCommandToken[] = []
      for (const token of tokens) {
        if (knownCommandNames.has(token.command)) {
          knownTokens.push(token)
        }
      }

      if (knownTokens.length === 0) {
        const parsed = detectSlashCommand(promptText)

        if (!parsed) {
          return
        }

        const commandKey = input.messageID
          ? `${input.sessionID}:${input.messageID}:${parsed.command}`
          : `${input.sessionID}:${parsed.command}`
        if (sessionProcessedCommands.has(commandKey)) {
          return
        }
        sessionProcessedCommands.add(commandKey)

        log(`[auto-slash-command] Detected: /${parsed.command}`, {
          sessionID: input.sessionID,
          args: parsed.args,
        })

        const result = await executeSlashCommand(parsed, executionOptions)

        const idx = findSlashCommandPartIndex(output.parts)
        if (idx < 0) {
          return
        }

        if (!result.success || !result.replacementText) {
          log(`[auto-slash-command] Command not found, skipping`, {
            sessionID: input.sessionID,
            command: parsed.command,
            error: result.error,
          })
          return
        }

        const taggedContent = `${AUTO_SLASH_COMMAND_TAG_OPEN}\n${result.replacementText}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`
        output.parts[idx].text = taggedContent

        log(`[auto-slash-command] Replaced message with command template`, {
          sessionID: input.sessionID,
          command: parsed.command,
        })
        return
      }

      const idx = findCommandPartIndex(output.parts, promptText, knownTokens[0])
      if (idx < 0) {
        return
      }

      const preservedProse = promptText.slice(0, knownTokens[0].tokenStart)

      const taggedTemplates: string[] = []
      for (let i = 0; i < knownTokens.length; i += 1) {
        const token = knownTokens[i]
        const commandKey = input.messageID
          ? `${input.sessionID}:${input.messageID}:${token.command}`
          : `${input.sessionID}:${token.command}`
        if (sessionProcessedCommands.has(commandKey)) {
          // Same command twice in one prompt: first occurrence wins, the second is skipped.
          continue
        }
        sessionProcessedCommands.add(commandKey)

        const nextTokenStart =
          i + 1 < knownTokens.length ? knownTokens[i + 1].tokenStart : promptText.length
        const args = promptText.slice(token.tokenEnd, nextTokenStart).trim()

        const result = await executeSlashCommand(
          {
            command: token.command,
            args,
            raw: promptText.slice(token.tokenStart, nextTokenStart).trim(),
          },
          executionOptions,
        )

        if (result.success && result.replacementText) {
          taggedTemplates.push(
            `${AUTO_SLASH_COMMAND_TAG_OPEN}\n${result.replacementText}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`
          )
        }
      }

      if (taggedTemplates.length === 0) {
        return
      }

      const templateText = taggedTemplates.join("\n\n")
      if (preservedProse.length > 0) {
        output.parts[idx].text = preservedProse
        output.parts.splice(idx + 1, 0, { type: "text", text: templateText })
      } else {
        output.parts[idx].text = templateText
      }

      log(`[auto-slash-command] Replaced message with command templates`, {
        sessionID: input.sessionID,
        commands: knownTokens.map((token) => token.command),
      })
    },

    "command.execute.before": async (
      input: CommandExecuteBeforeInput,
      output: CommandExecuteBeforeOutput
    ): Promise<void> => {
      if (partsContainAutoSlashCommandTags(output.parts)) {
        return
      }

      const eventID = getCommandExecutionEventID(input)
      const commandKey = eventID
        ? `${input.sessionID}:event:${eventID}`
        : `${input.sessionID}:fallback:${input.command.toLowerCase()}:${input.arguments || ""}`
      if (sessionProcessedCommandExecutions.has(commandKey)) {
        return
      }

      log(`[auto-slash-command] command.execute.before received`, {
        sessionID: input.sessionID,
        command: input.command,
        arguments: input.arguments,
      })

      const parsed = {
        command: input.command,
        args: input.arguments || "",
        raw: `/${input.command}${input.arguments ? " " + input.arguments : ""}`,
      }

      const executionOptions: ExecutorOptions = {
        ...executorOptions,
        agent: input.agent,
        sessionID: input.sessionID,
      }

      const result = await executeSlashCommand(parsed, executionOptions)

      if (!result.success || !result.replacementText) {
        log(`[auto-slash-command] command.execute.before - command not found in our executor`, {
          sessionID: input.sessionID,
          command: input.command,
          error: result.error,
        })
        return
      }

      sessionProcessedCommandExecutions.add(
        commandKey,
        eventID ? undefined : COMMAND_EXECUTE_FALLBACK_DEDUP_TTL_MS
      )

      const taggedContent = `${AUTO_SLASH_COMMAND_TAG_OPEN}\n${result.replacementText}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`

      const idx = findSlashCommandPartIndex(output.parts)
      if (idx >= 0) {
        output.parts[idx].text = taggedContent
      } else {
        output.parts.unshift({ type: "text", text: taggedContent })
      }

      log(`[auto-slash-command] command.execute.before - injected template`, {
        sessionID: input.sessionID,
        command: input.command,
      })
    },
    event: async ({
      event,
    }: {
      event: { type: string; properties?: unknown }
    }): Promise<void> => {
      if (event.type !== "session.deleted") {
        return
      }

      const sessionID = getDeletedSessionID(event.properties)
      if (!sessionID) {
        return
      }

      sessionProcessedCommands.cleanupSession(sessionID)
      sessionProcessedCommandExecutions.cleanupSession(sessionID)
    },
    dispose,
  }
}
