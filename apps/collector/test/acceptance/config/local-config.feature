Feature: Choose the local collector configuration at startup
  Scenario: Read history from the Codex directory in the selected configuration
    Given a configuration with a relative Codex path containing the chat "configured"
    And the shell points Codex at a different directory containing the chat "elsewhere"
    When I read February 1 history with that configuration
    Then the collector returns only the chat "configured"

  Scenario: Report an invalid configuration before reading history
    Given a configuration with an empty Codex path
    When I read February 1 history with that configuration
    Then the collector reports a configuration error for "codexPath"
