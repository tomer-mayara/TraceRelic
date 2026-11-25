import { type Fields, JsonRecord } from "../../transcript/json-record.ts";
import type { Role } from "../../storage/collector-storage.ts";

export type TextBlock = { text: string; blockIndex: number };

/** The text of a Codex record that the chat shows: its role and its text blocks. */
export class CodexVisibleText {
  static role(type: unknown, payload: Fields): Role | undefined {
    if (type === "event_msg") {
      if (payload.type === "user_message") return "user";
      if (payload.type === "agent_message") return "assistant";
    }
    if (type === "response_item" && payload.type === "message" && payload.channel !== "analysis"
      && (payload.role === "user" || payload.role === "assistant")) return payload.role;
  }

  static completedRole(type: unknown): Role | undefined {
    if (type === "UserMessage") return "user";
    if (type === "AgentMessage") return "assistant";
  }

  static completedBlocks(role: Role, item: Fields): TextBlock[] {
    if (!Array.isArray(item.content)) return [];
    if (role === "assistant" && !CodexVisibleText.displaysAnswer(item.moderation)) return [];
    return item.content.flatMap((value, blockIndex) => {
      const part = JsonRecord.object(value);
      if (part?.type !== (role === "user" ? "text" : "Text") || !JsonRecord.isNonemptyString(part.text)) return [];
      return [{ blockIndex, text: part.text }];
    });
  }

  private static displaysAnswer(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    const moderation = JsonRecord.object(value);
    if (!moderation || typeof moderation.moderated !== "boolean") return false;
    if (moderation.display === undefined || moderation.display === null) return !moderation.moderated;
    const display = JsonRecord.object(moderation.display);
    if (display?.version !== 1 || display.mode !== "show" || (display.trustedContacts !== "check" && display.trustedContacts !== "skip")) return false;
    if (display.annotation === undefined || display.annotation === null) return true;
    const annotation = JsonRecord.object(display.annotation);
    return annotation?.kind === "wellbeingHelpline" && (annotation.subject === "prompt" || annotation.subject === "answer");
  }

  static blocks(role: Role, event: boolean, payload: Fields): TextBlock[] {
    if (event) {
      const text = payload.message;
      if (!JsonRecord.isNonemptyString(text) || (role === "user" && CodexVisibleText.injectedUserText(text))) return [];
      return [{ text, blockIndex: 0 }];
    }
    const content = payload.content;
    if (!Array.isArray(content)) return [];
    const kinds = JsonRecord.object(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds;
    const blocks: TextBlock[] = [];
    for (const [blockIndex, part] of content.entries()) {
      const block = JsonRecord.object(part);
      if (block?.type !== (role === "user" ? "input_text" : "output_text")) continue;
      const text = block.text;
      if (!JsonRecord.isNonemptyString(text)) continue;
      const kind = Array.isArray(kinds) ? kinds[blockIndex] : undefined;
      if (role === "user" && (CodexVisibleText.injectedUserText(text, kind) || CodexVisibleText.mediaLabel(text, content, blockIndex))) continue;
      blocks.push({ text, blockIndex });
    }
    return blocks;
  }

  private static injectedUserText(text: string, kind?: unknown): boolean {
    // Codex marks text supplied by a user explicitly. Legacy records need the envelope check.
    if (JsonRecord.isNonemptyString(kind) && kind !== "unknown") return kind !== "user.text";
    const trimmed = text.trim();
    return /^<(environment_context|user_instructions|skill|subagent_notification|user_shell_command|codex_internal_context|goal_context|recommended_plugins)(?: [^>]*)?>[\s\S]*<\/\1>$/i.test(trimmed)
      || /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/.test(trimmed);
  }

  private static mediaLabel(text: string, content: readonly unknown[], index: number): boolean {
    const next = JsonRecord.object(content[index + 1])?.type;
    const previous = JsonRecord.object(content[index - 1])?.type;
    return (next === "input_image" && /^<image(?: name=[^>]+)?>$/.test(text))
      || (previous === "input_image" && text === "</image>")
      || (next === "input_audio" && /^<audio(?: name=[^>]+)?>$/.test(text))
      || (previous === "input_audio" && text === "</audio>");
  }
}
