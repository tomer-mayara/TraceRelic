import { JsonRecord } from "../../transcript/json-record.ts";

type TextBlock = { text: string; blockIndex: number };

/** The text blocks of a Claude Code message that a person sees. */
export class ClaudeVisibleText {
  static blocks(content: unknown, user: boolean): TextBlock[] {
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(parts)) return [];
    const blocks: TextBlock[] = [];
    for (const [blockIndex, part] of parts.entries()) {
      const block = JsonRecord.object(part);
      if (block?.type !== "text" || typeof block.text !== "string" || !block.text.length) continue;
      if (user && ClaudeVisibleText.injected(block.text)) continue;
      blocks.push({ blockIndex, text: block.text });
    }
    return blocks;
  }

  private static injected(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === "[Request interrupted by user]" || trimmed === "[Request interrupted by user for tool use]") return true;
    return /^<(tick|goal|ide_opened_file|ide_selection|session-start-hook|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*<\/\1>$/.test(trimmed)
      || /^<command-name>[^<]*<\/command-name>(?:\s*<command-message>[^<]*<\/command-message>)?(?:\s*<command-args>[\s\S]*<\/command-args>)?$/.test(trimmed);
  }
}
