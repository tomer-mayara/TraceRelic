@lc07
Feature: Preserve known data across a gap
  Scenario: Good records follow a damaged line
    Given a session has a known 70-token call followed by a malformed complete line
    When I read the next message "Continue" and a distinct 20-token call
    Then "Continue" is present and the partial total is 90
    And the report identifies the damaged byte range
