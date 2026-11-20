@lc17
Feature: Retry a failed ownership transfer

  Scenario: A failed batch preserves both sessions until the retry commits
    Given a child session owns a call that a parent batch can claim
    When a temporary database error interrupts the parent batch after records have been written
    Then a fresh reader sees the original text, usage, ownership, source state and versions
    When the writer retries the parent batch once from its old checkpoint
    Then a fresh reader sees the new text and source state and counts the call once for its parent
    And the API reports a temporary storage failure and a successful retry
