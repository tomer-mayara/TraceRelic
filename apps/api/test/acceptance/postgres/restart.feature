@lc16
Feature: Read stored data after an API restart
  Scenario: Two workspaces share a native session ID
    Given workspace A stored 120 tokens at byte 420 and workspace B stored 9 tokens at byte 70 for the same session
    When I restart the API with a new connection to the same database
    Then workspace A reads 120 tokens at byte 420 and workspace B reads 9 tokens at byte 70
