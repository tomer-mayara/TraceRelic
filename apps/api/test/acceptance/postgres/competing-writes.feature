@lc17
Feature: Apply a whole batch once
  Scenario: Two workers attempt the first write to one source
    Given two workers read version zero for the same source
    When they submit different first batches through independent database connections
    Then one worker sees committed and the other sees conflict
    And a new reader sees only the winner's records and checkpoint

  Scenario: Two sources keep both calls after the losing worker reloads
    Given two workers read version zero for different sources in the same session
    When they submit different first batches through independent database connections
    Then one worker sees committed and the other sees conflict
    And the losing source sees the winner's version and has no checkpoint
    When the losing worker reloads and retries its call once
    Then a new reader sees both calls once and both source checkpoints at version 2
