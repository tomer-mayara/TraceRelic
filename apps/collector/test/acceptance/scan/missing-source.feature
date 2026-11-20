@lc12
Feature: Explain what was lost when a file disappears
  Scenario Outline: A fresh collector confirms that a known source is missing
    Given this installation acknowledged 70 tokens through byte 420 and saw complete data through <end>
    When a fresh collector successfully scans all possible locations twice and the file is absent
    Then it reports one missing source at 420 and the total stays 70 with <coverage> coverage

    Examples:
      | end | coverage |
      | 420 | reported |
      | 500 | partial  |

  Scenario: An offline retry preserves the last complete suffix
    Given a measured rollout has a known unaccepted append and a later offline checkpoint read
    When the rollout disappears before storage reconnects
    Then the missing report includes the complete append and the measured coverage is partial

  Scenario: A direct Claude rotation preserves an anonymous continuation
    Given an accepted Claude transcript gains an anonymous message before it is renamed to a backup
    When I scan twice with only the backup present
    Then the anonymous continuation appears once under the original session
