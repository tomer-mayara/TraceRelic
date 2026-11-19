@lc00c
Feature: Use adjacent history windows
  Scenario Outline: A midnight message belongs to one day
    Given a <provider> transcript records "Midnight" at "2026-02-01T19:00:00-05:00"
    When I read February 1 UTC and February 2 UTC as separate one-day windows
    Then only the February 2 result contains "Midnight"
    And reading the two days together returns that record once

    Examples:
      | provider    |
      | Codex       |
      | Claude Code |
