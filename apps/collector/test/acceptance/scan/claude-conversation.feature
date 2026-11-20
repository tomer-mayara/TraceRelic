@lc02
Feature: Preserve Claude Code conversations
  Scenario: Two turns contain the same prompt
    Given a Claude session contains "Why?" twice and one assistant response has two text blocks
    When I scan its project twice
    Then both prompts appear and both answer blocks appear once in their original order

  Scenario: A fresh collector repairs accepted Claude backup bytes
    Given an older scanner accepted a current working directory and filled a missing repository from a superseded file
    When a fresh collector rescans their checkpoints twice
    Then the original working directory, fallback repository, branch and messages are preserved
