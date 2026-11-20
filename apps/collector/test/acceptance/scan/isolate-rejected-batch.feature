@lc09
Feature: Continue scanning other sources
  Scenario: One stream reuses a message ID for different text
    Given source A changes the stored text "Original" under the same ID and source B has a 12-token call
    When I scan both sources
    Then A keeps "Original" and its previous checkpoint
    And B shows 12 tokens and the scan identifies A's rejected range
