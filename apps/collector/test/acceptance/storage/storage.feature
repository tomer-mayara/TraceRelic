Feature: Store a collector batch
  Readers can recover the text and measured token usage of a local chat after a retry.

  Scenario: A planning chat has text before it has a token count
    Given an empty remote storage fixture
    When a collector submits the message "Plan the search feature" without usage
    Then the session contains "Plan the search feature"
    And its token total is unknown

  Scenario: An acknowledgement is lost
    Given a batch with 120 input tokens and 10 output tokens was stored
    When a collector retries that batch from its original position
    Then the collector is told to reload its checkpoint
    And the session still contains one usage record totaling 130 tokens

  Scenario: A provider completes an earlier usage observation
    Given a Claude request reported 40 input tokens and 2 output tokens
    When the same request is revised to 40 input tokens and 91 output tokens
    Then the session contains one usage record totaling 131 tokens

  Scenario: A batch contains an invalid token breakdown
    Given an empty remote storage fixture
    When a batch includes a message and more cached input tokens than input tokens
    Then the entire batch is rejected
    And the session and its checkpoint are absent

  Scenario: Two sources write to one session
    Given two sources start with version zero for the same session
    When the first commits a message and the second submits its original batch
    Then the second source has no checkpoint and sees session version 1

  Scenario: A missing source keeps its last accepted byte
    Given a source has reported 70 tokens at byte 420 of 500
    When the collector reports that source missing
    Then the source list and the session report it missing at byte 420

  Scenario: A final Claude report keeps its measured usage across a gap
    Given an empty remote storage fixture
    When a final Claude report includes 131 tokens and an unsupported iteration
    Then the session reports 131 tokens with partial coverage and the diagnostic for that source
