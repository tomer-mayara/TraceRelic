@lc14
Feature: Keep workspace data separate
  Scenario: Two credentials request the same session ID
    Given workspace A has a 130-token session and workspace B is empty
    When each workspace requests that session through the API
    Then A reads 130 and B sees no session

  Scenario: A credential has expired
    Given a new session has no stored checkpoint
    When a collector submits it with an expired credential
    Then the API returns an authentication error and stores nothing
