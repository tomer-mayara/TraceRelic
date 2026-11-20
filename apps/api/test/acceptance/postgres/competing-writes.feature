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

  Scenario: Growing one session submits each new message once to PostgreSQL
    Given I append 128 one-message batches to one session
    Then PostgreSQL has received 128 message projection rows
    When a fresh API records that the source has disappeared
    Then the 128 messages remain and PostgreSQL has received no more message rows
