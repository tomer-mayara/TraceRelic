@lc17
Feature: Apply a whole batch once
  Scenario: Two workers attempt the first write to one source
    Given two workers read version zero for the same source
    When they submit different first batches through independent database connections
    Then one worker sees committed and the other sees conflict
    And a new reader sees only the winner's records and checkpoint
