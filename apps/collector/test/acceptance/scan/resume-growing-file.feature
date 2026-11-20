@lc03
Feature: Resume a growing file
  Scenario: The writer stops inside a UTF-8 character
    Given one line is complete and the next ends between the two bytes of "é" in "café"
    When I scan once, finish the second line and scan with a fresh collector
    Then the first scan stores only the first message
    And the second scan stores "café" once and acknowledges its ending newline
    And both checkpoints record the accepted line and session version
