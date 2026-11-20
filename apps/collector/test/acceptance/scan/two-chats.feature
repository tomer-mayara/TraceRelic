@two_chats
Feature: Read token use for a planning chat
  Scenario: A restart preserves both chats and picks up new work
    Given a Codex planning chat has cumulative totals of 120, 120 and 200
    And one Claude request has 40 input tokens and reports 2 then 91 output tokens
    When I scan twice and restart the collector against the same storage
    Then the totals are 200 for Codex and 131 for Claude
    When I append a 30-token Codex call and scan again
    Then the totals are 230 for Codex and 131 for Claude
    And each original text block appears once in its chat
