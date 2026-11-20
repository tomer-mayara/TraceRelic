@lc02
Feature: Preserve Claude Code conversations
  Scenario: Two turns contain the same prompt
    Given a Claude session contains "Why?" twice and one assistant response has two text blocks
    When I scan its project twice
    Then both prompts appear and both answer blocks appear once in their original order
