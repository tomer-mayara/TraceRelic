Feature: Read history with one reader for the configured providers
  Scenario: One reader returns Codex and Claude Code records for the same day
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index" on February 1
    When I read February 1 UTC with one reader for both providers
    Then I get "Plan search" for "codex/c1" and then "Use an index" for "claude/h1"

  Scenario: A reader for Codex alone does not return Claude Code records
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index" on February 1
    When I read February 1 UTC with a reader for Codex alone
    Then I get only "Plan search" for "codex/c1"
