@lc04
Feature: Account for each measured Codex token once
  Scenario: A cumulative update covers more than the last call
    Given the last cumulative total was 120 and a later identified call of 20 was already counted
    When the total reaches 200 and the last call reports 30
    Then the session total is 200
    And the new measurements are the last call of 30 and an interval of 30

  Scenario: A second copy gives more detail about the same 200 tokens
    Given one installation recorded a verified interval of 200 tokens
    When another copy splits it into 120 and 80 and I scan both copies again
    Then the session still shows 200 tokens and the two parts account for the whole interval

  Scenario: A second identifier names the same call
    Given two copies report a 10-token Codex call and one adds a request ID
    When the call reports are scanned in both orders
    Then each session shows one 10-token Codex call

  Scenario: Native and legacy records describe one response
    Given a native Codex response and a legacy counter describe the same 120 tokens
    When the native and legacy reports are scanned in both orders
    Then each session shows one 120-token native response owned by its thread
