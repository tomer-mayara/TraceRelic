@lc11
Feature: Keep one owner for each Claude call
  Scenario Outline: A child inherits a 100-token parent call
    Given a Claude parent used 100 tokens and its <child> copies that call
    And the child makes a separate 25-token call
    When I collect both transcripts in either order
    Then the parent shows 100 and the linked child shows 25

    Examples:
      | child                          |
      | fork with new transcript UUIDs |
      | subagent with the parent ID    |
