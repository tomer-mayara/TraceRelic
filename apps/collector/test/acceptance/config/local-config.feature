Feature: Choose the local collector configuration at startup
  Scenario: Read history from the Codex directory in the selected configuration
    Given a configuration with a relative Codex path containing the chat "configured"
    And the shell points Codex at a different directory containing the chat "elsewhere"
    When I read February 1 history with that configuration
    Then the collector returns only the chat "configured"
    And the collector writes no diagnostics to standard error

  Scenario: Read both providers from the selected configuration
    Given a configuration with a Codex chat "c1" and a Claude chat "h1" in separate directories
    When I read February 1 history with that configuration
    Then the collector returns the chats "codex/c1" and "claude/h1"

  Scenario: Report an invalid configuration before reading history
    Given a configuration with an empty Codex path
    When I read February 1 history with that configuration
    Then the collector writes one ERROR log for "codexPath" to standard error
    And standard output is empty

  Scenario: Both providers keep the recorded precision of a CLI history window
    Given both configured providers recorded a chat at "2026-02-01T12:00:00.0003Z"
    When I read the configured history from "2026-02-01T12:00:00.0002Z" to "2026-02-01T12:00:00.0007Z"
    Then the collector returns the chats "codex/c1" and "claude/h1"
