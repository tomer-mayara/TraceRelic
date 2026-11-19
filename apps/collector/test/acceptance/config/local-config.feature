Feature: Choose the local collector configuration at startup
  Scenario: Read history from the Codex directory in the selected configuration
    Given a configuration with a relative Codex path containing the chat "configured"
    And the shell points Codex at a different directory containing the chat "elsewhere"
    When I read February 1 history with that configuration
    Then the collector returns only the chat "configured"

  Scenario: Read both providers from the selected configuration
    Given a configuration with a Codex chat "c1" and a Claude chat "h1" in separate directories
    When I read February 1 history with that configuration
    Then the collector returns the chats "codex/c1" and "claude/h1"

  Scenario: Report an invalid configuration before reading history
    Given a configuration with an empty Codex path
    When I read February 1 history with that configuration
    Then the collector reports a configuration error for "codexPath"
