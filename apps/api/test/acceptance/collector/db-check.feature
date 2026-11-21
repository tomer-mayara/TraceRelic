@db-check
Feature: Check a PostgreSQL connection
  Scenario: PostgreSQL responds
    Given PostgreSQL is available to the database check
    When I run the database check
    Then stdout contains one JSON object with the database name and server version
    And the check exits successfully with empty stderr

  Scenario: PostgreSQL cannot be reached
    Given the database check has an unreachable PostgreSQL address
    When I run the database check
    Then stderr contains one ERROR for the failed database check
    And the check exits with status 1 and leaves stdout empty
