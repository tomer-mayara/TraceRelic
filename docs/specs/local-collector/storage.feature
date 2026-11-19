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
