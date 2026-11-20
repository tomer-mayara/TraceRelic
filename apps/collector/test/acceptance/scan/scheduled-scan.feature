@lc13
Feature: Pick up a chat created after startup
  Scenario: A planning chat appears between scans
    Given the startup scan finished and a new planning chat appears before the next interval
    When the next interval elapses
    Then the chat is readable and the scan reports one new session
