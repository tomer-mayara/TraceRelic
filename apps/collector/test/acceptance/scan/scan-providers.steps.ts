import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { InMemoryCollectorStorage } from "@tracerelic/collector/memory-storage";
import { ClaudeHistory, CodexHistory, LocalProviders } from "@tracerelic/collector/providers";
import { LocalCollector } from "@tracerelic/collector/scan";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Codex } from "../../fixtures/codex-rollout-fixture.ts";
import { ProviderHistoryFixture } from "../../fixtures/provider-history-fixture.ts";
import { scanContract as contract } from "../../fixtures/scan-contract.ts";

const at = "2026-02-01T12:00:00Z";

/** The workspace of one scenario, and the chats that its two provider roots record. */
class ProviderWorkspace {
  readonly storage = new InMemoryCollectorStorage();

  constructor(readonly roots: ProviderHistoryFixture, readonly chats: readonly string[]) {}

  /** The message texts of a chat such as "codex/c1", or undefined when the workspace has no session for the chat. */
  async texts(chat: string): Promise<string[] | undefined> {
    const [harness, sessionId] = chat.split("/");
    assert(harness === "codex" || harness === "claude", chat);
    const session = await this.storage.readSession({ harness, sessionId });
    if (session) assert(contract.validate("SessionView.json", session), contract.errorsText());
    return session?.messages.map(message => message.text);
  }
}

interface ProviderScanScenario {
  providerWorkspace?: ProviderWorkspace;
}

Given("Codex chat {string} records {string} and Claude Code chat {string} records {string}", async function (
  this: ProviderScanScenario, codexChat: string, codexText: string, claudeChat: string, claudeText: string,
) {
  const roots = await ProviderHistoryFixture.create();
  this.providerWorkspace = new ProviderWorkspace(roots, ["codex/" + codexChat, "claude/" + claudeChat]);
  await roots.codex.write([Codex.header(codexChat), Codex.message(at, codexText)]);
  await roots.claude.write("-work", claudeChat, [Claude.assistant(claudeChat, at, claudeText)]);
});

When("I scan with one scanner for both providers", async function (this: ProviderScanScenario) {
  const workspace = this.providerWorkspace;
  assert(workspace);
  const providers = LocalProviders.fromConfig(workspace.roots.config());
  await new LocalCollector({ providers, storage: workspace.storage }).scanOnce();
});

When("I scan with a scanner for Codex alone", async function (this: ProviderScanScenario) {
  const workspace = this.providerWorkspace;
  assert(workspace);
  await new LocalCollector({ providers: [new CodexHistory(workspace.roots.codex.home)], storage: workspace.storage }).scanOnce();
});

When("I scan with a scanner for Claude Code alone", async function (this: ProviderScanScenario) {
  const workspace = this.providerWorkspace;
  assert(workspace);
  await new LocalCollector({ providers: [new ClaudeHistory(workspace.roots.claude.home)], storage: workspace.storage }).scanOnce();
});

Then("the workspace has {string} for {string} and {string} for {string}", async function (
  this: ProviderScanScenario, firstText: string, firstChat: string, secondText: string, secondChat: string,
) {
  const workspace = this.providerWorkspace;
  assert(workspace);
  assert.deepEqual(await workspace.texts(firstChat), [firstText]);
  assert.deepEqual(await workspace.texts(secondChat), [secondText]);
});

Then("the workspace has only {string} for {string}", async function (this: ProviderScanScenario, text: string, chat: string) {
  const workspace = this.providerWorkspace;
  assert(workspace);
  assert.deepEqual(await workspace.texts(chat), [text]);
  for (const other of workspace.chats.filter(name => name !== chat)) {
    assert.equal(await workspace.texts(other), undefined, `the workspace has a session for ${other}`);
  }
});

After(async function (this: ProviderScanScenario) { await this.providerWorkspace?.roots.close(); });
