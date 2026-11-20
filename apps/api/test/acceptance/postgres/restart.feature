@lc16
Feature: Read stored data after an API restart
  Scenario: Two workspaces share a native session ID
    Given workspace A stored 120 tokens at byte 420 and workspace B stored 9 tokens at byte 70 for the same session
    When I restart the API with a new connection to the same database
    Then workspace A reads 120 tokens at byte 420 and workspace B reads 9 tokens at byte 70

  Scenario: Recovery can verify the complete suffix that disappeared before upload
    Given workspace A accepted 420 bytes and observed a complete suffix through byte 500 before the source disappeared
    When I restart the API with a new connection to the same database
    Then workspace A can verify the missing suffix through byte 500 and its checkpoint is still at byte 420

  @legacy-journal
  Scenario: A workspace can sync a new chat after upgrading from LC-17
    Given LC-17 stored a Claude fork with a copied advisor and a later parent message
    When the upgraded API accepts a new chat with 9 tokens
    Then the earlier parent still reports 100 tokens and the child still reports 25
    And the new chat reports 9 tokens after an API restart
