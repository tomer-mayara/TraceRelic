@lc13
Feature: Pick up a chat created after startup
  Scenario: A planning chat appears between scans
    Given the startup scan finished and a new planning chat appears before the next interval
    When the next interval elapses
    Then the chat is readable and the scan reports one new session

  Scenario: Watch can complete a pass without downloading the conversation
    Given a selected planning chat has already been accepted by storage
    When scheduled scans run twice with no new records
    Then both reports show completion and no final conversations were requested
