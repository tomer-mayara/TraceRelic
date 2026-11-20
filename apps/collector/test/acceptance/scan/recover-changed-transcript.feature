@lc06
Feature: Recover a changed transcript
  Scenario: A rewritten file reaches the same byte offset
    Given a writer holds the old checkpoint at byte 420 for a 120-token call
    And a replacement file contains that identified call and a new 30-token call
    When a fresh collector accepts the new file through byte 420 and the old writer submits its batch
    Then the old writer receives a conflict and the session still has two calls totaling 150

  Scenario: A rollout moves while the checkpoint is read
    Given a rollout is about to move to its archive beside an independent chat
    When the move happens during the scan
    Then both the moved and independent chats are stored

  Scenario: Accepted bytes were filed under the wrong native session by an older scanner
    Given an older scanner filed a verified prompt under a different native session with independent messages
    When the current scanner reads the native session and its accepted prefix
    Then the prompt appears only in its native session and the independent messages remain
