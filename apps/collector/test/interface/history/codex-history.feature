@lc00a
Feature: Read local Codex history
  Scenario: A chat continues past the day its rollout was created
    Given the Codex rollout for "c1" starts on January 31 and contains these messages
      | recorded at              | text         |
      | 2026-01-31T23:59:59.999Z | Earlier      |
      | 2026-02-01T00:00:00.000Z | Plan search  |
      | 2026-02-01T12:00:00.000Z | Use an index |
      | 2026-02-02T00:00:00.000Z | Next day     |
    When I read history from "2026-02-01T00:00:00Z" to "2026-02-02T00:00:00Z"
    Then I get only "Plan search" and "Use an index" in that order for "codex/c1"
