Feature: Scan with one scanner for the providers that it receives

  Scenario: One scanner imports Codex and Claude Code chats
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index"
    When I scan with one scanner for both providers
    Then the workspace has "Plan search" for "codex/c1" and "Use an index" for "claude/h1"

  Scenario: A scanner for Codex alone does not import Claude Code chats
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index"
    When I scan with a scanner for Codex alone
    Then the workspace has only "Plan search" for "codex/c1"

  Scenario: A scanner for Claude Code alone does not import Codex chats
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index"
    When I scan with a scanner for Claude Code alone
    Then the workspace has only "Use an index" for "claude/h1"
