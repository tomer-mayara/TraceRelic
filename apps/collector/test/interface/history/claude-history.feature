@lc00b
Feature: Read local Claude Code history
  Scenario: Two selected projects have messages in the same hour
    Given Claude Code project transcripts contain these records on February 1, 2026 UTC
      | session | time     | role      | text         |
      | h1      | 09:59:59 | user      | Earlier      |
      | h1      | 10:00:00 | user      | Plan search  |
      | h2      | 10:30:00 | assistant | Use an index |
      | h2      | 11:00:00 | user      | Later        |
    When I read history from "2026-02-01T10:00:00Z" to "2026-02-01T11:00:00Z"
    Then I get only "Plan search" for "claude/h1" and "Use an index" for "claude/h2"
