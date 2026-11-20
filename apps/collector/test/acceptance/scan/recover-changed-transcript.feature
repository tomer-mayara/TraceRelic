@lc06
Feature: Recover a changed transcript
  Scenario: A rewritten file reaches the same byte offset
    Given a writer holds the old checkpoint at byte 420 for a 120-token call
    And a replacement file contains that identified call and a new 30-token call
    When a fresh collector accepts the new file through byte 420 and the old writer submits its batch
    Then the old writer receives a conflict and the session still has two calls totaling 150
