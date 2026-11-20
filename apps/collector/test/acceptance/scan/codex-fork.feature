@lc10
Feature: Separate parent and child usage
  Scenario: The parent continues after the fork
    Given a Codex parent had 200 tokens at the fork and now has 260
    And the child copied the prefix of 200 and its next cumulative total is 225
    When I discover the child before the archived parent and scan twice
    Then the parent shows 260 and the linked child shows 25

  Scenario Outline: An earlier parent prefix preserves the verified fork
    Given a Codex parent had 200 tokens at the fork and now has 260
    And the child copied the prefix of 200 and its next cumulative total is 225
    When I discover the child before the archived parent and scan twice
    And the parent is available as <copies> and I scan again
    Then the parent shows 260 and the linked child shows 25

    Examples:
      | copies                   |
      | only its shorter prefix  |
      | both full and short files |
