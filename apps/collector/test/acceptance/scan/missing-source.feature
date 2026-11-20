@lc12
Feature: Explain what was lost when a file disappears
  Scenario Outline: A fresh collector confirms that a known source is missing
    Given this installation acknowledged 70 tokens through byte 420 and saw complete data through <end>
    When a fresh collector successfully scans all possible locations twice and the file is absent
    Then it reports one missing source at 420 and the total stays 70 with <coverage> coverage

    Examples:
      | end | coverage |
      | 420 | reported |
      | 500 | partial  |
