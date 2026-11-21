Feature: Read API diagnostics separately from JSON events
  Scenario: The API starts with an invalid port
    Given the API port is set to "invalid-port"
    When the operator starts the API
    Then stderr contains one ERROR log that explains the valid port range
    And the API exits with status 1 and leaves stdout empty
