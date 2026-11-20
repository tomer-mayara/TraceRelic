@lc05
Feature: Keep one measurement per Claude request
  Scenario: A tool-only row updates an earlier text response
    Given a request uses 10 ordinary, 25 cache-read and 5 cache-write input tokens
    And its text row reports 2 output tokens and its later tool row reports 91
    When I scan both rows and replay the earlier report
    Then the session has one request with 40 input tokens and 91 output tokens
    And the session total is 131

  Scenario: A copy supplies the ID for an advisor at its recorded position
    Given two copies report the same 10-token executor and 6-token advisor
    When the copies are scanned in both orders with an advisor ID in one copy
    Then each session shows 16 tokens and one advisor measurement
