@lc01
Feature: Import visible Codex chat text
  Scenario: A chat has no edits or token counts
    Given a selected Codex session contains the prompt "Plan search" and the reply "Start with ranking"
    When I scan its root once
    Then its session contains both messages in source order with their roles and recorded times
    And its token total is null with unknown coverage
