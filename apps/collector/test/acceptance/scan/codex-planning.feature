@lc01
Feature: Import visible Codex chat text
  Scenario: A chat has no edits or token counts
    Given a selected Codex session contains the prompt "Plan search" and the reply "Start with ranking"
    When I scan its root once
    Then its session contains both messages in source order with their roles and recorded times
    And its token total is null with unknown coverage

  Scenario: A paginated rollout contains model input and the visible conversation
    Given the paginated rollout records model input and a different completed prompt and answer
    When I scan its root once
    Then only the completed prompt and answer appear with their native item IDs
